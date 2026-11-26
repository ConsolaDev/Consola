import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../adapters/persistence/database.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import {
  makeTestWorkspace,
  nextMillisecond,
  openTestDatabase,
} from '../adapters/persistence/testDatabase.js';
import { FIRST_TEAM_NAME, TEAM_NAME_MAX } from '../domain/team.js';
import type { TeamStore } from './ports.js';
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  listTeams,
  removeTeamMember,
  renameTeam,
} from './teams.js';
import { callerAs as caller, fakeMembership } from './testMembership.js';
import type { FakeMembership } from './testMembership.js';

let db: Database;
let close: () => Promise<void>;
let teams: TeamStore;
let membership: FakeMembership;

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  ({ teams } = createDrizzleStores(db));
  membership = fakeMembership();
});

afterEach(async () => {
  await close();
});

/** Acme, made whole, with Dana (owner), Eli (admin) and Fay (member) in its first team. */
async function acme() {
  await makeTestWorkspace(db, membership, 'acme', [
    ['person-dana', 'owner'],
    ['person-eli', 'admin'],
    ['person-fay', 'member'],
  ]);
}

const dana = () => caller('person-dana', 'owner');
const eli = () => caller('person-eli', 'admin');
const fay = () => caller('person-fay', 'member');

async function platform() {
  const answer = await createTeam(teams, dana(), { name: 'Platform' });
  if (answer.kind !== 'created') throw new Error(`Platform was not made: ${answer.kind}`);
  return answer.team;
}

async function firstTeam() {
  const answer = await listTeams(teams, membership, dana());
  const first = answer.teams.find((team) => team.first);
  if (!first) throw new Error('Acme has no first team');
  return first;
}

describe('listTeams', () => {
  it('shows owners and admins every team, and that they manage them', async () => {
    await acme();
    const made = await platform();
    for (const who of [dana(), eli()]) {
      const answer = await listTeams(teams, membership, who);
      expect(answer).toMatchObject({ kind: 'listed', canManage: true });
      expect(answer.teams.map((team) => team.name)).toEqual([FIRST_TEAM_NAME, made.name]);
    }
  });

  it('shows a member the teams they are in, and that they do not manage them', async () => {
    await acme();
    await platform();
    const answer = await listTeams(teams, membership, fay());
    expect(answer).toMatchObject({ kind: 'listed', canManage: false });
    expect(answer.teams).toEqual([
      {
        id: expect.any(String),
        name: FIRST_TEAM_NAME,
        first: true,
        memberIds: ['person-dana', 'person-eli', 'person-fay'],
      },
    ]);
  });

  it('acts with the role the caller was admitted with this request', async () => {
    await acme();
    await platform();
    // Eli was an admin; demoted, the request is admitted with the member's role.
    membership.put('acme', 'person-eli', 'member');
    const answer = await listTeams(teams, membership, caller('person-eli', 'member'));
    expect(answer).toMatchObject({ kind: 'listed', canManage: false });
    expect(answer.teams.map((team) => team.name)).toEqual([FIRST_TEAM_NAME]);
  });

  it("never reads another workspace's teams", async () => {
    await acme();
    await platform();
    await makeTestWorkspace(db, membership, 'sprocket', [['person-dana', 'owner']]);
    const answer = await listTeams(teams, membership, caller('person-dana', 'owner', 'sprocket'));
    expect(answer.teams.map((team) => team.name)).toEqual([FIRST_TEAM_NAME]);
  });

  it('lists only people who are members of the workspace now, whatever places are left', async () => {
    await acme();
    const made = await platform();
    await addTeamMember(teams, membership, eli(), made.id, 'person-fay');
    // Fay leaves the workspace, and nothing has taken her places out of its teams yet.
    membership.remove('acme', 'person-fay');

    const answer = await listTeams(teams, membership, dana());
    expect(answer.teams.map((team) => [team.name, team.memberIds])).toEqual([
      [FIRST_TEAM_NAME, ['person-dana', 'person-eli']],
      ['Platform', []],
    ]);
    // Every answer that holds a team shows it so.
    await nextMillisecond();
    expect(await renameTeam(teams, membership, eli(), made.id, { name: 'Apps' })).toEqual({
      kind: 'renamed',
      team: { ...made, name: 'Apps', memberIds: [] },
    });
    expect(await addTeamMember(teams, membership, eli(), made.id, 'person-eli')).toEqual({
      kind: 'changed',
      team: { ...made, name: 'Apps', memberIds: ['person-eli'] },
    });
    const first = await firstTeam();
    expect(await removeTeamMember(teams, membership, eli(), first.id, 'person-eli')).toMatchObject({
      kind: 'changed',
      team: { memberIds: ['person-dana'] },
    });
    // The place is still there: should Fay come back, so is she.
    membership.put('acme', 'person-fay', 'member');
    expect((await listTeams(teams, membership, dana())).teams[1]?.memberIds).toEqual([
      'person-fay',
      'person-eli',
    ]);
  });
});

describe('changing teams', () => {
  it('is for owners and admins: a member is refused before anything else is read', async () => {
    // Not even a team is there, and the name is no name: the role is judged first.
    expect(await createTeam(teams, fay(), { name: '' })).toEqual({ kind: 'not-allowed' });
    expect(await renameTeam(teams, membership, fay(), 'x', { name: '' })).toEqual({
      kind: 'not-allowed',
    });
    expect(await deleteTeam(teams, fay(), 'x')).toEqual({ kind: 'not-allowed' });
    expect(await addTeamMember(teams, membership, fay(), 'x', 'person-fay')).toEqual({
      kind: 'not-allowed',
    });
    expect(await removeTeamMember(teams, membership, fay(), 'x', 'person-fay')).toEqual({
      kind: 'not-allowed',
    });
  });

  it('names every problem with a name before the store is asked', async () => {
    expect(await createTeam(teams, eli(), { name: ' ' })).toEqual({
      kind: 'invalid',
      problems: ['name_missing'],
    });
    expect(
      await renameTeam(teams, membership, eli(), 'x', { name: 'a'.repeat(TEAM_NAME_MAX + 1) }),
    ).toEqual({ kind: 'invalid', problems: ['name_too_long'] });
    expect(await renameTeam(teams, membership, eli(), 'x', { name: 'Platform' })).toEqual({
      kind: 'not-found',
    });
  });

  it('makes, renames and deletes a team, keeping names unique in any case', async () => {
    await acme();
    const made = await platform();
    expect(made).toMatchObject({ name: 'Platform', first: false, memberIds: [] });
    expect(await createTeam(teams, eli(), { name: ' platform ' })).toEqual({ kind: 'name-taken' });
    expect(await renameTeam(teams, membership, eli(), made.id, { name: '  Apps ' })).toEqual({
      kind: 'renamed',
      team: { ...made, name: 'Apps' },
    });
    expect(await deleteTeam(teams, eli(), made.id)).toEqual({ kind: 'deleted' });
    expect(await deleteTeam(teams, eli(), made.id)).toEqual({ kind: 'not-found' });
  });

  it('never deletes the first team', async () => {
    await acme();
    const first = await firstTeam();
    expect(await deleteTeam(teams, dana(), first.id)).toEqual({ kind: 'first-team' });
  });

  it('never deletes a team that owns a factory', async () => {
    await acme();
    const made = await platform();
    const { factories } = createDrizzleStores(db);
    await factories.create('acme', { name: 'Deploys', teamId: made.id, personId: 'person-dana' });
    expect(await deleteTeam(teams, dana(), made.id)).toEqual({ kind: 'owns-factories' });
  });

  it("adds only the workspace's members, asked of accounts first, and takes people out", async () => {
    await acme();
    await makeTestWorkspace(db, membership, 'sprocket', [['person-gus', 'owner']]);
    const made = await platform();
    // Gus is a member of another workspace, and nobody's id is anybody's.
    for (const personId of ['person-gus', 'person-nobody']) {
      expect(await addTeamMember(teams, membership, eli(), made.id, personId)).toEqual({
        kind: 'not-a-member',
      });
    }
    // Membership is asked before the team is looked for.
    expect(await addTeamMember(teams, membership, eli(), 'no-such-team', 'person-gus')).toEqual({
      kind: 'not-a-member',
    });
    expect(await addTeamMember(teams, membership, eli(), 'no-such-team', 'person-fay')).toEqual({
      kind: 'not-found',
    });
    expect(await addTeamMember(teams, membership, eli(), made.id, 'person-fay')).toEqual({
      kind: 'changed',
      team: { ...made, memberIds: ['person-fay'] },
    });
    expect(await removeTeamMember(teams, membership, eli(), made.id, 'person-fay')).toEqual({
      kind: 'changed',
      team: made,
    });
    expect(await removeTeamMember(teams, membership, eli(), 'no-such-team', 'person-fay')).toEqual({
      kind: 'not-found',
    });
  });

  it('finds no team of another workspace to change', async () => {
    await acme();
    const made = await platform();
    await makeTestWorkspace(db, membership, 'sprocket', [['person-dana', 'owner']]);
    const inSprocket = caller('person-dana', 'owner', 'sprocket');
    expect(await renameTeam(teams, membership, inSprocket, made.id, { name: 'Mine' })).toEqual({
      kind: 'not-found',
    });
    expect(await deleteTeam(teams, inSprocket, made.id)).toEqual({ kind: 'not-found' });
    expect(await addTeamMember(teams, membership, inSprocket, made.id, 'person-dana')).toEqual({
      kind: 'not-found',
    });
  });
});
