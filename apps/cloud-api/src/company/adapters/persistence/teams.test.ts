import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TeamStore } from '../../application/ports.js';
import { FIRST_TEAM_NAME } from '../../domain/team.js';
import type { Team } from '../../domain/team.js';
import type { Database } from './database.js';
import { createTeamStore, openWorkspace } from './teams.js';
import { nextMillisecond, openTestDatabase } from './testDatabase.js';

let db: Database;
let close: () => Promise<void>;
let teams: TeamStore;

/**
 * Opens `workspaceId` as making it does, with `ownerId` in its first team, then puts `others` in
 * that team too, as each joins.
 */
async function workspace(workspaceId: string, ownerId = 'person-dana', others: string[] = []) {
  await db.transaction((tx) => openWorkspace(tx, { workspaceId, ownerId }));
  const first = await firstTeamOf(workspaceId);
  for (const personId of others) {
    await nextMillisecond();
    await teams.addMember(workspaceId, first.id, personId);
  }
}

async function firstTeamOf(workspaceId: string): Promise<Team> {
  const first = (await teams.list(workspaceId)).find((team) => team.first);
  if (!first) throw new Error(`${workspaceId} has no first team`);
  return first;
}

/** A team the test made, or a failure that names why not. */
async function made(workspaceId: string, name: string): Promise<Team> {
  const team = await teams.create(workspaceId, name);
  if (team === 'name-taken') throw new Error(`${name} was taken`);
  return team;
}

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  teams = createTeamStore(db);
});

afterEach(async () => {
  await close();
});

describe('opening a workspace', () => {
  it('makes its first team, with its owner in it, and nothing for another workspace', async () => {
    expect(await teams.list('acme')).toEqual([]);
    await db.transaction((tx) =>
      openWorkspace(tx, { workspaceId: 'acme', ownerId: 'person-dana' }),
    );
    expect(await teams.list('acme')).toEqual([
      { id: expect.any(String), name: FIRST_TEAM_NAME, first: true, memberIds: ['person-dana'] },
    ]);
    expect(await teams.list('sprocket')).toEqual([]);
  });

  it('changes nothing when it is opened again, even after its first team changed', async () => {
    await workspace('acme', 'person-dana', ['person-eli']);
    const first = await firstTeamOf('acme');
    await teams.rename('acme', first.id, 'Everyone');
    await teams.removeMember('acme', first.id, 'person-dana');
    const before = await teams.list('acme');

    await db.transaction((tx) =>
      openWorkspace(tx, { workspaceId: 'acme', ownerId: 'person-dana' }),
    );
    await db.transaction((tx) => openWorkspace(tx, { workspaceId: 'acme', ownerId: 'person-fay' }));
    expect(await teams.list('acme')).toEqual(before);
    expect(before).toEqual([
      { id: first.id, name: 'Everyone', first: true, memberIds: ['person-eli'] },
    ]);
  });

  it('opened twice in a row makes one first team', async () => {
    await db.transaction(async (tx) => {
      await openWorkspace(tx, { workspaceId: 'acme', ownerId: 'person-dana' });
      await openWorkspace(tx, { workspaceId: 'acme', ownerId: 'person-dana' });
    });
    expect(await teams.list('acme')).toEqual([
      { id: expect.any(String), name: FIRST_TEAM_NAME, first: true, memberIds: ['person-dana'] },
    ]);
  });

  it('leaves nothing when the transaction that makes the workspace fails', async () => {
    const failed = new Error('making the workspace failed after it was opened');
    await expect(
      db.transaction(async (tx) => {
        await openWorkspace(tx, { workspaceId: 'acme', ownerId: 'person-dana' });
        throw failed;
      }),
    ).rejects.toBe(failed);
    expect(await teams.list('acme')).toEqual([]);

    // Nothing is half there: opening it again makes it whole.
    await workspace('acme');
    expect(await teams.list('acme')).toMatchObject([{ first: true, memberIds: ['person-dana'] }]);
  });
});

describe('the team store', () => {
  it('lists the first team first, then the others by name whatever its case', async () => {
    await workspace('acme');
    const design = await made('acme', 'design');
    const platform = await made('acme', 'Platform');
    const apps = await made('acme', 'Apps');
    const listed = await teams.list('acme');
    expect(listed.map((team) => team.name)).toEqual([
      FIRST_TEAM_NAME,
      'Apps',
      'design',
      'Platform',
    ]);
    expect(listed.slice(1)).toEqual([apps, design, platform]);
  });

  it('makes a team with an id of its own and nobody in it', async () => {
    await workspace('acme');
    const platform = await made('acme', 'Platform');
    expect(platform).toEqual({
      id: expect.any(String),
      name: 'Platform',
      first: false,
      memberIds: [],
    });
    expect(platform.id).not.toBe((await made('acme', 'Apps')).id);
  });

  it("refuses a name another of the workspace's teams has, in any case", async () => {
    await workspace('acme');
    await workspace('sprocket');
    await made('acme', 'Platform');
    expect(await teams.create('acme', 'platform')).toBe('name-taken');
    expect(await teams.create('acme', FIRST_TEAM_NAME.toUpperCase())).toBe('name-taken');
    // Another workspace's names are its own.
    expect(await teams.create('sprocket', 'Platform')).not.toBe('name-taken');
  });

  it('renames a team, the first one included, keeping its members', async () => {
    await workspace('acme');
    const general = await firstTeamOf('acme');
    expect(await teams.rename('acme', general.id, 'Everyone')).toEqual({
      id: general.id,
      name: 'Everyone',
      first: true,
      memberIds: ['person-dana'],
    });
  });

  it('renames a team to its own name in another case, but never to another team’s', async () => {
    await workspace('acme');
    const platform = await made('acme', 'Platform');
    await made('acme', 'Apps');
    expect(await teams.rename('acme', platform.id, 'PLATFORM')).toMatchObject({ name: 'PLATFORM' });
    expect(await teams.rename('acme', platform.id, 'apps')).toBe('name-taken');
  });

  it("finds no team of another workspace, or one that isn't there", async () => {
    await workspace('acme');
    await workspace('sprocket');
    const platform = await made('acme', 'Platform');
    expect(await teams.rename('sprocket', platform.id, 'Mine')).toBe('not-found');
    expect(await teams.remove('sprocket', platform.id)).toBe('not-found');
    expect(await teams.addMember('sprocket', platform.id, 'person-dana')).toBe('not-found');
    expect(await teams.removeMember('sprocket', platform.id, 'person-dana')).toBe('not-found');
    expect(await teams.rename('acme', 'no-such-team', 'Mine')).toBe('not-found');
    expect(await teams.addMember('acme', 'no-such-team', 'person-dana')).toBe('not-found');
    expect((await teams.list('acme')).map((team) => team.name)).toEqual([
      FIRST_TEAM_NAME,
      'Platform',
    ]);
    expect((await teams.list('acme'))[1]?.memberIds).toEqual([]);
  });

  it('deletes a team and every place in it, but never the first team', async () => {
    await workspace('acme');
    const platform = await made('acme', 'Platform');
    await teams.addMember('acme', platform.id, 'person-dana');
    const general = await firstTeamOf('acme');

    expect(await teams.remove('acme', general.id)).toBe('first-team');
    expect(await teams.remove('acme', platform.id)).toBe('removed');
    expect(await teams.remove('acme', platform.id)).toBe('not-found');
    expect(await teams.list('acme')).toEqual([general]);
  });

  it('adds a person to a team once, in the order they joined it', async () => {
    await workspace('acme');
    const platform = await made('acme', 'Platform');

    await teams.addMember('acme', platform.id, 'person-eli');
    await nextMillisecond();
    expect(await teams.addMember('acme', platform.id, 'person-dana')).toEqual({
      ...platform,
      memberIds: ['person-eli', 'person-dana'],
    });
    expect(await teams.addMember('acme', platform.id, 'person-eli')).toEqual({
      ...platform,
      memberIds: ['person-eli', 'person-dana'],
    });
  });

  it('takes a person out of a team, and changes nothing for someone not in it', async () => {
    await workspace('acme', 'person-dana', ['person-eli']);
    const general = await firstTeamOf('acme');
    expect(await teams.removeMember('acme', general.id, 'person-dana')).toMatchObject({
      memberIds: ['person-eli'],
    });
    expect(await teams.removeMember('acme', general.id, 'person-dana')).toMatchObject({
      memberIds: ['person-eli'],
    });
  });
});
