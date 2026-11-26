import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from '../../application/ports.js';
import type { GitHubInstallation } from '../../domain/connections.js';
import { migrateDatabase, openDatabase } from './database.js';
import type { Database } from './database.js';
import { createInstallationStore } from './installationStore.js';
import { schema } from './schema.js';

let db: Database;
let close: () => Promise<void>;
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

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db.insert(schema.user).values([
    { id: 'dana', name: 'Dana', email: 'dana@sprocket.test', emailVerified: true },
    { id: 'lee', name: 'Lee', email: 'lee@sprocket.test', emailVerified: true },
  ]);
  await db.insert(schema.organization).values([
    { id: 'sprocket', name: 'Sprocket', slug: 'sprocket', region: 'eu', createdAt: new Date() },
    { id: 'catalog', name: 'Catalog', slug: 'catalog', region: 'us', createdAt: new Date() },
  ]);
  installations = createInstallationStore(db);
});

afterEach(async () => {
  await close();
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
    expect(await installations.ofWorkspace('catalog')).toEqual([]);
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
        workspaceId: 'catalog',
        connectedBy: 'lee',
        at: at('2026-11-22T11:00:00Z'),
      }),
    ).toBe('taken');

    expect(await installations.ofWorkspace('catalog')).toEqual([]);
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
      ['sprocket', 'catalog'].map((workspaceId) =>
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
      await installations.disconnect({ workspaceId: 'catalog', installationId: sprocketOrg.id }),
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
        workspaceId: 'catalog',
        connectedBy: 'lee',
        at: at('2026-11-22T10:00:00Z'),
      }),
    ).toBe('connected');
  });

  it('goes with its workspace, and outlives the account of whoever connected it', async () => {
    await installations.connect({
      installation: sprocketOrg,
      workspaceId: 'sprocket',
      connectedBy: 'dana',
      at: at('2026-11-22T09:00:00Z'),
    });
    await installations.connect({
      installation: danaOwn,
      workspaceId: 'catalog',
      connectedBy: 'dana',
      at: at('2026-11-22T09:00:00Z'),
    });

    await db.delete(schema.user).where(eq(schema.user.id, 'dana'));
    const [row] = await db
      .select({ connectedBy: schema.githubInstallation.connectedBy })
      .from(schema.githubInstallation)
      .where(eq(schema.githubInstallation.installationId, danaOwn.id));
    expect(row).toEqual({ connectedBy: null });

    await db.delete(schema.organization).where(eq(schema.organization.id, 'sprocket'));
    expect(await installations.ofWorkspace('sprocket')).toEqual([]);
    expect(await installations.ofWorkspace('catalog')).toHaveLength(1);
  });

  it('refuses to read back an account type GitHub does not have', async () => {
    await db.insert(schema.githubInstallation).values({
      installationId: 1,
      organizationId: 'sprocket',
      accountId: 1,
      accountLogin: 'odd',
      accountType: 'Enterprise',
      connectedAt: new Date(),
    });
    await expect(installations.ofWorkspace('sprocket')).rejects.toThrow(
      'GitHub installation 1 has an unknown account type, "Enterprise".',
    );
  });

  it('names the workspace that holds an installation, and its region, for its events', async () => {
    await installations.connect({
      installation: sprocketOrg,
      workspaceId: 'catalog',
      connectedBy: 'dana',
      at: at('2026-11-22T09:00:00Z'),
    });
    await installations.connect({
      installation: danaOwn,
      workspaceId: 'sprocket',
      connectedBy: 'dana',
      at: at('2026-11-22T09:00:00Z'),
    });

    expect(await installations.holderOf(sprocketOrg.id)).toEqual({
      workspaceId: 'catalog',
      region: 'us',
    });
    expect(await installations.holderOf(danaOwn.id)).toEqual({
      workspaceId: 'sprocket',
      region: 'eu',
    });
    expect(await installations.holderOf(4_100_003)).toBeNull();

    // Disconnected, it is held by no workspace, and its events go nowhere.
    await installations.disconnect({ workspaceId: 'catalog', installationId: sprocketOrg.id });
    expect(await installations.holderOf(sprocketOrg.id)).toBeNull();
  });
});
