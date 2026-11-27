import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from '../../application/gitHubPorts.js';
import type { GitHubInstallation } from '../../domain/connections.js';
import { createGitHubStores } from './gitHubStores.js';
import * as gitHubTables from './gitHubTables.js';

const { githubInstallation } = gitHubTables;

let client: PGlite;
let db: PgliteDatabase;
let installations: InstallationStore;

const sprocketOrg: GitHubInstallation = {
  id: 4_100_001,
  account: { id: 9001, login: 'sprocket', type: 'Organization' },
  repositorySelection: 'selected',
};
const danaOwn: GitHubInstallation = {
  id: 4_100_002,
  account: { id: 9002, login: 'dana-ortiz', type: 'User' },
  repositorySelection: 'all',
};

const at = (iso: string) => new Date(iso);

// GitHub's three tables alone, made from their definitions: nothing else is in the database, so
// no row here can lean on an account table.
beforeEach(async () => {
  client = new PGlite();
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(gitHubTables),
  );
  for (const statement of statements) await client.exec(statement);
  db = drizzle(client);
  ({ installations } = createGitHubStores(db));
});

afterEach(async () => {
  await client.close();
});

describe('the installation store', () => {
  it("records a workspace's installations and lists them in the order they were connected", async () => {
    expect(
      await installations.connect({
        installation: danaOwn,
        workspaceId: 'sprocket',
        connectedBy: 'dana',
        at: at('2026-11-22T10:00:00Z'),
      }),
    ).toBe('connected');
    expect(
      await installations.connect({
        installation: sprocketOrg,
        workspaceId: 'sprocket',
        connectedBy: 'dana',
        at: at('2026-11-22T09:00:00Z'),
      }),
    ).toBe('connected');

    expect(await installations.ofWorkspace('sprocket')).toEqual([
      { id: sprocketOrg.id, account: sprocketOrg.account, connectedAt: at('2026-11-22T09:00:00Z') },
      { id: danaOwn.id, account: danaOwn.account, connectedAt: at('2026-11-22T10:00:00Z') },
    ]);
    expect(await installations.ofWorkspace('acme')).toEqual([]);
  });

  it('refuses an installation another workspace holds, and writes nothing', async () => {
    await installations.connect({
      installation: sprocketOrg,
      workspaceId: 'sprocket',
      connectedBy: 'dana',
      at: at('2026-11-22T09:00:00Z'),
    });
    const renamed = { ...sprocketOrg, account: { ...sprocketOrg.account, login: 'renamed' } };
    expect(
      await installations.connect({
        installation: renamed,
        workspaceId: 'acme',
        connectedBy: 'lee',
        at: at('2026-11-22T11:00:00Z'),
      }),
    ).toBe('taken');

    expect(await installations.ofWorkspace('acme')).toEqual([]);
    const [sprocket] = await installations.ofWorkspace('sprocket');
    expect(sprocket?.account.login).toBe('sprocket');
  });

  it('connecting one it holds again keeps it, under the account GitHub names now', async () => {
    await installations.connect({
      installation: sprocketOrg,
      workspaceId: 'sprocket',
      connectedBy: 'dana',
      at: at('2026-11-22T09:00:00Z'),
    });
    const renamed = { ...sprocketOrg, account: { ...sprocketOrg.account, login: 'sprocket-co' } };
    expect(
      await installations.connect({
        installation: renamed,
        workspaceId: 'sprocket',
        connectedBy: 'lee',
        at: at('2026-11-22T12:00:00Z'),
      }),
    ).toBe('already-connected');

    expect(await installations.ofWorkspace('sprocket')).toEqual([
      {
        id: sprocketOrg.id,
        account: { ...sprocketOrg.account, login: 'sprocket-co' },
        connectedAt: at('2026-11-22T09:00:00Z'),
      },
    ]);
  });

  it('two workspaces claiming one installation at once get one owner', async () => {
    const claims = await Promise.all(
      ['sprocket', 'acme'].map((workspaceId) =>
        installations.connect({
          installation: sprocketOrg,
          workspaceId,
          connectedBy: 'dana',
          at: at('2026-11-22T09:00:00Z'),
        }),
      ),
    );
    expect(claims.sort()).toEqual(['connected', 'taken']);
  });

  it("disconnects only the workspace's own installation", async () => {
    await installations.connect({
      installation: sprocketOrg,
      workspaceId: 'sprocket',
      connectedBy: 'dana',
      at: at('2026-11-22T09:00:00Z'),
    });

    expect(
      await installations.disconnect({ workspaceId: 'acme', installationId: sprocketOrg.id }),
    ).toBe(false);
    expect(await installations.ofWorkspace('sprocket')).toHaveLength(1);

    expect(
      await installations.disconnect({ workspaceId: 'sprocket', installationId: sprocketOrg.id }),
    ).toBe(true);
    expect(await installations.ofWorkspace('sprocket')).toEqual([]);
    expect(
      await installations.disconnect({ workspaceId: 'sprocket', installationId: sprocketOrg.id }),
    ).toBe(false);
  });

  it('once disconnected, another workspace can connect it', async () => {
    await installations.connect({
      installation: sprocketOrg,
      workspaceId: 'sprocket',
      connectedBy: 'dana',
      at: at('2026-11-22T09:00:00Z'),
    });
    await installations.disconnect({ workspaceId: 'sprocket', installationId: sprocketOrg.id });
    expect(
      await installations.connect({
        installation: sprocketOrg,
        workspaceId: 'acme',
        connectedBy: 'lee',
        at: at('2026-11-22T10:00:00Z'),
      }),
    ).toBe('connected');
  });

  it('keeps who connected it as their id, whatever becomes of their account or workspace', async () => {
    await installations.connect({
      installation: danaOwn,
      workspaceId: 'acme',
      connectedBy: 'dana',
      at: at('2026-11-22T09:00:00Z'),
    });
    const [row] = await db
      .select({
        workspaceId: githubInstallation.workspaceId,
        connectedBy: githubInstallation.connectedBy,
      })
      .from(githubInstallation)
      .where(eq(githubInstallation.installationId, danaOwn.id));
    expect(row).toEqual({ workspaceId: 'acme', connectedBy: 'dana' });

    // Ids only: no foreign key reaches out of GitHub's tables.
    const keys = (await db.execute(
      sql`select table_name from information_schema.table_constraints where constraint_type = 'FOREIGN KEY'`,
    )) as { rows: unknown[] };
    expect(keys.rows).toEqual([]);
  });

  it('refuses to read back an account type GitHub does not have', async () => {
    await db.insert(githubInstallation).values({
      installationId: 1,
      workspaceId: 'sprocket',
      connectedBy: 'dana',
      accountId: 1,
      accountLogin: 'odd',
      accountType: 'Enterprise',
      connectedAt: new Date(),
    });
    await expect(installations.ofWorkspace('sprocket')).rejects.toThrow(
      'GitHub installation 1 has an unknown account type, "Enterprise".',
    );
  });

  it('names the workspace that holds an installation, for its events', async () => {
    await installations.connect({
      installation: sprocketOrg,
      workspaceId: 'acme',
      connectedBy: 'dana',
      at: at('2026-11-22T09:00:00Z'),
    });
    await installations.connect({
      installation: danaOwn,
      workspaceId: 'sprocket',
      connectedBy: 'dana',
      at: at('2026-11-22T09:00:00Z'),
    });

    expect(await installations.holderOf(sprocketOrg.id)).toBe('acme');
    expect(await installations.holderOf(danaOwn.id)).toBe('sprocket');
    expect(await installations.holderOf(4_100_003)).toBeNull();

    // Disconnected, it is held by no workspace, and its events go nowhere.
    await installations.disconnect({ workspaceId: 'acme', installationId: sprocketOrg.id });
    expect(await installations.holderOf(sprocketOrg.id)).toBeNull();
  });
});
