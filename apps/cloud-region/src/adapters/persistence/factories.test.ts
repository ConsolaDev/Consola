import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FactoryStore, TeamStore } from '../../application/ports.js';
import type { Factory } from '../../domain/factory.js';
import type { Team } from '../../domain/team.js';
import { type Database, migrateDatabase, openDatabase } from './database.js';
import { createFactoryStore } from './factories.js';
import { createTeamStore } from './teams.js';
import { createWorkspaceCopies } from './workspaceCopies.js';

let db: Database;
let close: () => Promise<void>;
let factories: FactoryStore;
let teams: TeamStore;

/** Opens `workspaceId` in the copy, the way the outbox does, and answers its first team. */
async function workspace(workspaceId: string): Promise<Team> {
  await createWorkspaceCopies(db).applyAfter({
    workspaceId,
    sequence: 1,
    after: null,
    change: { kind: 'open-workspace' },
  });
  const [first] = await teams.list(workspaceId);
  if (!first) throw new Error(`${workspaceId} has no first team`);
  return first;
}

/** A factory the test made, or a failure that names why not. */
async function made(workspaceId: string, name: string, teamId: string): Promise<Factory> {
  const factory = await factories.create(workspaceId, { name, teamId, personId: 'person-dana' });
  if (typeof factory === 'string') throw new Error(`${name} was not made: ${factory}`);
  return factory;
}

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  factories = createFactoryStore(db);
  teams = createTeamStore(db);
});

afterEach(async () => {
  await close();
});

describe('the factory store', () => {
  it('makes a factory blank: owned by its team, stored here, its first version holding no files', async () => {
    const general = await workspace('acme');
    const deploys = await made('acme', 'Deploys', general.id);
    expect(deploys).toEqual({
      id: expect.any(String),
      name: 'Deploys',
      teamId: general.id,
      source: { kind: 'stored' },
      latestVersion: 1,
      updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    expect(await factories.get('acme', deploys.id)).toEqual(deploys);
    expect(await factories.version('acme', deploys.id, 1)).toEqual({
      factoryId: deploys.id,
      version: 1,
      savedAt: deploys.updatedAt,
      savedBy: 'person-dana',
      files: [],
    });
  });

  it("lists a workspace's factories by name whatever its case, and no other workspace's", async () => {
    const general = await workspace('acme');
    const sprocket = await workspace('sprocket');
    await made('acme', 'reviews', general.id);
    await made('acme', 'Deploys', general.id);
    await made('sprocket', 'Billing', sprocket.id);
    expect((await factories.list('acme')).map((factory) => factory.name)).toEqual([
      'Deploys',
      'reviews',
    ]);
  });

  it('keeps names unique in a workspace whatever their case, and only there', async () => {
    const general = await workspace('acme');
    const sprocket = await workspace('sprocket');
    await made('acme', 'Deploys', general.id);
    expect(
      await factories.create('acme', { name: 'DEPLOYS', teamId: general.id, personId: 'p' }),
    ).toBe('name-taken');
    await made('sprocket', 'Deploys', sprocket.id);
  });

  it('makes a factory only for a team of its own workspace', async () => {
    await workspace('acme');
    const sprocket = await workspace('sprocket');
    for (const teamId of [sprocket.id, 'no-such-team']) {
      expect(await factories.create('acme', { name: 'Deploys', teamId, personId: 'p' })).toBe(
        'team-not-found',
      );
    }
    expect(await factories.list('acme')).toEqual([]);
  });

  it('saves files as the next version, and keeps every earlier one readable', async () => {
    const general = await workspace('acme');
    const deploys = await made('acme', 'Deploys', general.id);

    const second = await factories.save('acme', deploys.id, {
      baseVersion: 1,
      personId: 'person-eli',
      files: [
        { path: 'factory.yml', content: 'version: 1\nautomations:\n' },
        { path: 'agents/b.md', content: 'B' },
        { path: 'agents/a.md', content: 'A' },
      ],
    });
    expect(second).toEqual({
      kind: 'saved',
      version: {
        factoryId: deploys.id,
        version: 2,
        savedAt: expect.any(String),
        savedBy: 'person-eli',
        files: [
          { path: 'agents/a.md', content: 'A' },
          { path: 'agents/b.md', content: 'B' },
          { path: 'factory.yml', content: 'version: 1\nautomations:\n' },
        ],
      },
    });
    const third = await factories.save('acme', deploys.id, {
      baseVersion: 2,
      personId: 'person-dana',
      files: [{ path: 'agents/a.md', content: 'A, again' }],
    });
    expect(third).toMatchObject({ kind: 'saved', version: { version: 3 } });

    expect(await factories.get('acme', deploys.id)).toMatchObject({ latestVersion: 3 });
    expect(await factories.version('acme', deploys.id, 3)).toEqual(
      third.kind === 'saved' ? third.version : null,
    );
    expect(await factories.version('acme', deploys.id, 2)).toEqual(
      second.kind === 'saved' ? second.version : null,
    );
    expect((await factories.version('acme', deploys.id, 1))?.files).toEqual([]);
    expect(await factories.version('acme', deploys.id, 4)).toBeNull();
  });

  it('refuses a save from a version that is no longer the latest, changing nothing', async () => {
    const general = await workspace('acme');
    const deploys = await made('acme', 'Deploys', general.id);
    const files = [{ path: 'agents/a.md', content: 'A' }];
    await factories.save('acme', deploys.id, { baseVersion: 1, personId: 'p', files });

    for (const baseVersion of [1, 7]) {
      expect(
        await factories.save('acme', deploys.id, { baseVersion, personId: 'p', files }),
      ).toEqual({ kind: 'moved', latestVersion: 2 });
    }
    expect(await factories.get('acme', deploys.id)).toMatchObject({ latestVersion: 2 });
    expect(await factories.version('acme', deploys.id, 3)).toBeNull();
  });

  it("has none of another workspace's factories: not found, never saved", async () => {
    const general = await workspace('acme');
    await workspace('sprocket');
    const deploys = await made('acme', 'Deploys', general.id);
    expect(await factories.get('sprocket', deploys.id)).toBeNull();
    expect(await factories.version('sprocket', deploys.id, 1)).toBeNull();
    expect(
      await factories.save('sprocket', deploys.id, { baseVersion: 1, personId: 'p', files: [] }),
    ).toEqual({ kind: 'not-found' });
    expect(await factories.get('acme', deploys.id)).toMatchObject({ latestVersion: 1 });
  });

  it('renames a factory and moves it to another team in one change, keeping its versions', async () => {
    const general = await workspace('acme');
    const platform = await teams.create('acme', 'Platform');
    if (platform === 'name-taken') throw new Error('Platform was taken');
    const deploys = await made('acme', 'Deploys', general.id);
    const files = [{ path: 'agents/a.md', content: 'A' }];
    await factories.save('acme', deploys.id, { baseVersion: 1, personId: 'p', files });
    const saved = await factories.get('acme', deploys.id);

    expect(await factories.change('acme', deploys.id, { name: 'deploys' })).toEqual({
      ...saved,
      name: 'deploys',
    });
    expect(await factories.change('acme', deploys.id, { teamId: platform.id })).toEqual({
      ...saved,
      name: 'deploys',
      teamId: platform.id,
    });
    expect(
      await factories.change('acme', deploys.id, { name: 'Ship', teamId: general.id }),
    ).toEqual({ ...saved, name: 'Ship', teamId: general.id });
    expect(await factories.change('acme', deploys.id, {})).toEqual({
      ...saved,
      name: 'Ship',
      teamId: general.id,
    });
    expect((await factories.version('acme', deploys.id, 2))?.files).toEqual(files);
  });

  it('changes nothing of a change it refuses: neither its name nor its team', async () => {
    const general = await workspace('acme');
    const sprocket = await workspace('sprocket');
    const deploys = await made('acme', 'Deploys', general.id);
    await made('acme', 'Reviews', general.id);
    const platform = await teams.create('acme', 'Platform');
    if (platform === 'name-taken') throw new Error('Platform was taken');

    expect(
      await factories.change('acme', deploys.id, { name: 'REVIEWS', teamId: platform.id }),
    ).toBe('name-taken');
    for (const teamId of [sprocket.id, 'no-such-team']) {
      expect(await factories.change('acme', deploys.id, { name: 'Ship', teamId })).toBe(
        'team-not-found',
      );
    }
    expect(await factories.get('acme', deploys.id)).toEqual(deploys);
  });

  it("has none of another workspace's factories to change", async () => {
    const general = await workspace('acme');
    const sprocket = await workspace('sprocket');
    const deploys = await made('acme', 'Deploys', general.id);
    expect(await factories.change('sprocket', deploys.id, { name: 'Mine' })).toBe('not-found');
    expect(await factories.change('sprocket', deploys.id, { teamId: sprocket.id })).toBe(
      'not-found',
    );
    expect(await factories.change('sprocket', deploys.id, {})).toBe('not-found');
    expect(await factories.get('acme', deploys.id)).toEqual(deploys);
  });

  it('moves the hold on deletion with the factory: its new team stays, its old one may go', async () => {
    const general = await workspace('acme');
    const platform = await teams.create('acme', 'Platform');
    const apps = await teams.create('acme', 'Apps');
    if (platform === 'name-taken' || apps === 'name-taken') throw new Error('a name was taken');
    const deploys = await made('acme', 'Deploys', platform.id);
    await factories.change('acme', deploys.id, { teamId: apps.id });
    expect(await teams.remove('acme', apps.id)).toBe('owns-factories');
    expect(await teams.remove('acme', platform.id)).toBe('removed');
    // A team already gone is no team to move to.
    expect(await factories.change('acme', deploys.id, { teamId: platform.id })).toBe(
      'team-not-found',
    );
    expect((await teams.list('acme')).map((team) => team.id)).toEqual([general.id, apps.id]);
  });

  it('never leaves a factory on a deleted team, when a move and the delete come at once', async () => {
    await workspace('acme');
    const platform = await teams.create('acme', 'Platform');
    const apps = await teams.create('acme', 'Apps');
    if (platform === 'name-taken' || apps === 'name-taken') throw new Error('a name was taken');
    const deploys = await made('acme', 'Deploys', platform.id);
    const [moved, removed] = await Promise.all([
      factories.change('acme', deploys.id, { teamId: apps.id }),
      teams.remove('acme', apps.id),
    ]);
    // One wins: the move, and the delete finds the team owns it; or the delete, and the move
    // finds no team. PGlite runs one transaction at a time, so this pins the answers; on
    // Postgres the foreign key's lock on the team's row is what orders the two.
    expect([
      [{ ...deploys, teamId: apps.id }, 'owns-factories'],
      ['team-not-found', 'removed'],
    ]).toContainEqual([moved, removed]);
    const now = await factories.get('acme', deploys.id);
    expect((await teams.list('acme')).map((team) => team.id)).toContain(now?.teamId);
  });

  it('keeps a team that owns a factory: the team is not deleted', async () => {
    const general = await workspace('acme');
    const platform = await teams.create('acme', 'Platform');
    if (platform === 'name-taken') throw new Error('Platform was taken');
    await made('acme', 'Deploys', platform.id);
    expect(await teams.remove('acme', platform.id)).toBe('owns-factories');
    expect((await teams.list('acme')).map((team) => team.id)).toEqual([general.id, platform.id]);
  });
});
