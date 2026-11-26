import type { WorkspaceRole } from '@consola/cloud-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TeamStore } from '../../application/ports.js';
import { FIRST_TEAM_NAME } from '../../domain/team.js';
import type { Team } from '../../domain/team.js';
import { migrateDatabase, openDatabase } from './database.js';
import type { Database } from './database.js';
import { createTeamStore } from './teams.js';
import { createWorkspaceCopies } from './workspaceCopies.js';

let db: Database;
let close: () => Promise<void>;
let teams: TeamStore;

/** Opens `workspaceId` in the copy, with `members`, the way the outbox does. */
async function workspace(workspaceId: string, members: Array<[string, WorkspaceRole]> = []) {
  const copies = createWorkspaceCopies(db);
  await copies.applyAfter({
    workspaceId,
    sequence: 1,
    after: null,
    change: { kind: 'open-workspace' },
  });
  let sequence = 1;
  for (const [personId, role] of members) {
    sequence += 1;
    await copies.applyAfter({
      workspaceId,
      sequence,
      after: sequence - 1,
      change: { kind: 'put-member', personId, role },
    });
  }
}

/** A team the test made, or a failure that names why not. */
async function made(workspaceId: string, name: string): Promise<Team> {
  const team = await teams.create(workspaceId, name);
  if (team === 'name-taken') throw new Error(`${name} was taken`);
  return team;
}

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  teams = createTeamStore(db);
});

afterEach(async () => {
  await close();
});

describe('the team store', () => {
  it('holds a workspace once its copy is opened, and not before', async () => {
    expect(await teams.holdsWorkspace('acme')).toBe(false);
    await workspace('acme');
    expect(await teams.holdsWorkspace('acme')).toBe(true);
  });

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
    await workspace('acme', [['person-dana', 'owner']]);
    const [general] = await teams.list('acme');
    expect(await teams.rename('acme', general?.id ?? '', 'Everyone')).toEqual({
      id: general?.id,
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
    await workspace('acme', [['person-dana', 'owner']]);
    await workspace('sprocket', [['person-dana', 'owner']]);
    const platform = await made('acme', 'Platform');
    expect(await teams.rename('sprocket', platform.id, 'Mine')).toBe('not-found');
    expect(await teams.remove('sprocket', platform.id)).toBe('not-found');
    expect(await teams.addMember('sprocket', platform.id, 'person-dana')).toBe('not-found');
    expect(await teams.removeMember('sprocket', platform.id, 'person-dana')).toBe('not-found');
    expect(await teams.rename('acme', 'no-such-team', 'Mine')).toBe('not-found');
    expect((await teams.list('acme')).map((team) => team.name)).toEqual([
      FIRST_TEAM_NAME,
      'Platform',
    ]);
  });

  it('deletes a team and every place in it, but never the first team', async () => {
    await workspace('acme', [['person-dana', 'owner']]);
    const platform = await made('acme', 'Platform');
    await teams.addMember('acme', platform.id, 'person-dana');
    const [general] = await teams.list('acme');

    expect(await teams.remove('acme', general?.id ?? '')).toBe('first-team');
    expect(await teams.remove('acme', platform.id)).toBe('removed');
    expect(await teams.remove('acme', platform.id)).toBe('not-found');
    expect(await teams.list('acme')).toEqual([general]);
  });

  it('adds only members of the workspace, each once, in the order they joined the team', async () => {
    await workspace('acme', [
      ['person-dana', 'owner'],
      ['person-eli', 'member'],
    ]);
    await workspace('sprocket', [['person-fay', 'owner']]);
    const platform = await made('acme', 'Platform');

    expect(await teams.addMember('acme', platform.id, 'person-fay')).toBe('not-a-member');
    expect(await teams.addMember('acme', platform.id, 'person-nobody')).toBe('not-a-member');
    await teams.addMember('acme', platform.id, 'person-eli');
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
    await workspace('acme', [
      ['person-dana', 'owner'],
      ['person-eli', 'member'],
    ]);
    const [general] = await teams.list('acme');
    expect(await teams.removeMember('acme', general?.id ?? '', 'person-dana')).toMatchObject({
      memberIds: ['person-eli'],
    });
    expect(await teams.removeMember('acme', general?.id ?? '', 'person-dana')).toMatchObject({
      memberIds: ['person-eli'],
    });
  });
});
