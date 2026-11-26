import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TokenMintStore } from '../../application/gitHubPorts.js';
import type { TokenMint } from '../../domain/gitHubTokens.js';
import { createGitHubStores } from './gitHubStores.js';
import * as gitHubTables from './gitHubTables.js';

let client: PGlite;
let db: PgliteDatabase;
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

// GitHub's three tables alone, made from their definitions. Acme holds installation 41 and
// Sprocket 52.
beforeEach(async () => {
  client = new PGlite();
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(gitHubTables),
  );
  for (const statement of statements) await client.exec(statement);
  db = drizzle(client);
  const stores = createGitHubStores(db);
  for (const [id, workspaceId] of [
    [41, 'acme'],
    [52, 'sprocket'],
  ] as const) {
    await stores.installations.connect({
      installation: {
        id,
        account: { id: id + 9000, login: workspaceId, type: 'Organization' },
        repositorySelection: 'selected',
      },
      workspaceId,
      connectedBy: 'dana',
      at: at('2026-11-22T09:00:00Z'),
    });
  }
  mints = stores.mints;
});

afterEach(async () => {
  await client.close();
});

describe('the token mint store', () => {
  it('says a workspace holds the installation it connected', async () => {
    expect(await mints.holds({ workspaceId: 'acme', installationId: 41 })).toBe(true);
    expect(await mints.holds({ workspaceId: 'sprocket', installationId: 52 })).toBe(true);
  });

  it("says no for another workspace's installation, one nobody holds, or no workspace", async () => {
    expect(await mints.holds({ workspaceId: 'acme', installationId: 52 })).toBe(false);
    expect(await mints.holds({ workspaceId: 'sprocket', installationId: 41 })).toBe(false);
    expect(await mints.holds({ workspaceId: 'acme', installationId: 99 })).toBe(false);
    expect(await mints.holds({ workspaceId: 'nobody', installationId: 41 })).toBe(false);
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
    )) as { rows: Array<{ column_name: string }> };
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      'expires_at',
      'id',
      'installation_id',
      'minted_at',
      'permissions',
      'purpose',
      'repository_ids',
      'workspace_id',
    ]);
  });

  it('refuses a purpose the domain does not name, or a mint for no repository', async () => {
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
