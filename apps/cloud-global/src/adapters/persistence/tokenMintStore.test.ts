import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TokenMintStore } from '../../application/ports.js';
import type { TokenMint } from '../../domain/gitHubTokens.js';
import { migrateDatabase, openDatabase } from './database.js';
import type { Database } from './database.js';
import { schema } from './schema.js';
import { createTokenMintStore } from './tokenMintStore.js';

let db: Database;
let close: () => Promise<void>;
let mints: TokenMintStore;

const at = (iso: string) => new Date(iso);

const pull: TokenMint = {
  workspaceId: 'acme',
  installationId: 41,
  purpose: 'factory-pull',
  repositoryIds: [410],
  permissions: { contents: 'read', metadata: 'read' },
  mintedAt: at('2026-11-22T10:00:00Z'),
  expiresAt: at('2026-11-22T11:00:00Z'),
};

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db.insert(schema.organization).values([
    { id: 'acme', name: 'Acme', slug: 'acme', region: 'eu', createdAt: new Date() },
    { id: 'sprocket', name: 'Sprocket', slug: 'sprocket', region: 'us', createdAt: new Date() },
  ]);
  await db.insert(schema.githubInstallation).values([
    {
      installationId: 41,
      organizationId: 'acme',
      accountId: 9_001,
      accountLogin: 'acme',
      accountType: 'Organization',
      connectedAt: at('2026-11-22T09:00:00Z'),
    },
    {
      installationId: 52,
      organizationId: 'sprocket',
      accountId: 9_002,
      accountLogin: 'sprocket',
      accountType: 'Organization',
      connectedAt: at('2026-11-22T09:00:00Z'),
    },
  ]);
  mints = createTokenMintStore(db);
});

afterEach(async () => {
  await close();
});

describe('the token mint store', () => {
  it("gives the workspace's region when it holds the installation", async () => {
    expect(await mints.holding({ workspaceId: 'acme', installationId: 41 })).toEqual({
      region: 'eu',
    });
    expect(await mints.holding({ workspaceId: 'sprocket', installationId: 52 })).toEqual({
      region: 'us',
    });
  });

  it("is null for another workspace's installation, one nobody holds, or no workspace", async () => {
    expect(await mints.holding({ workspaceId: 'acme', installationId: 52 })).toBeNull();
    expect(await mints.holding({ workspaceId: 'sprocket', installationId: 41 })).toBeNull();
    expect(await mints.holding({ workspaceId: 'acme', installationId: 99 })).toBeNull();
    expect(await mints.holding({ workspaceId: 'nobody', installationId: 41 })).toBeNull();
  });

  it("records each mint, and lists a workspace's oldest first", async () => {
    const save = {
      ...pull,
      purpose: 'factory-save' as const,
      permissions: { contents: 'write', metadata: 'read' },
      mintedAt: at('2026-11-22T09:30:00Z'),
      expiresAt: at('2026-11-22T10:30:00Z'),
    };
    const review = {
      ...pull,
      workspaceId: 'sprocket',
      installationId: 52,
      purpose: 'review-run' as const,
      repositoryIds: [520, 521],
      permissions: { contents: 'read', pull_requests: 'write', metadata: 'read' },
    };
    await mints.record(pull);
    await mints.record(save);
    await mints.record(review);

    expect(await mints.mintsOf('acme')).toEqual([save, pull]);
    expect(await mints.mintsOf('sprocket')).toEqual([review]);
    expect(await mints.mintsOf('nobody')).toEqual([]);
  });

  it('keeps no token: no column could hold one', async () => {
    const columns = (await db.execute(
      sql`select column_name from information_schema.columns where table_name = 'github_token_mint'`,
    )) as { rows: { column_name: string }[] };
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      'expires_at',
      'id',
      'installation_id',
      'minted_at',
      'organization_id',
      'permissions',
      'purpose',
      'repository_ids',
    ]);
  });

  it('refuses a purpose the contract does not name, or a mint for no repository', async () => {
    await expect(
      mints.record({ ...pull, purpose: 'admin' as TokenMint['purpose'] }),
    ).rejects.toThrow();
    await expect(mints.record({ ...pull, repositoryIds: [] })).rejects.toThrow();
    expect(await mints.mintsOf('acme')).toEqual([]);
  });

  it('refuses to read back a row nothing here wrote, rather than guess its purpose', async () => {
    await mints.record(pull);
    await db.execute(
      sql`alter table github_token_mint drop constraint github_token_mint_purpose_check`,
    );
    await db.execute(sql`update github_token_mint set purpose = 'admin'`);
    await expect(mints.mintsOf('acme')).rejects.toThrow(/unknown purpose/);
  });
});
