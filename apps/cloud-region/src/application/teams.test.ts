import { cellTokenClaims, type WorkspaceRole } from '@consola/cloud-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import { admitClaims, type Caller } from '../domain/caller.js';
import { FIRST_TEAM_NAME, TEAM_NAME_MAX } from '../domain/team.js';
import type { CopyChange } from '../domain/workspaceCopy.js';
import type { TeamStore, WorkspaceCopies } from './ports.js';
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  listTeams,
  removeTeamMember,
  renameTeam,
} from './teams.js';

let db: Database;
let close: () => Promise<void>;
let teams: TeamStore;
let workspaceCopies: WorkspaceCopies;

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  ({ teams, workspaceCopies } = createDrizzleStores(db));
});

afterEach(async () => {
  await close();
});

/** Who a checked cell token names: only `admitClaims` makes a caller. */
function caller(personId: string, role: WorkspaceRole, workspaceId = 'acme'): Caller {
  const now = Math.floor(Date.now() / 1000);
  const claims = cellTokenClaims({ personId, workspaceId, role, region: 'eu', issuedAt: now });
  const admitted = admitClaims(claims, now, 'eu');
  if (admitted.kind !== 'accepted') throw new Error('the token was not accepted');
  return admitted.caller;
}

/** Acme, opened in the copy with Dana (owner), Eli (admin) and Fay (member). */
async function acme() {
  let sequence = 1;
  await workspaceCopies.applyAfter({
    workspaceId: 'acme',
    sequence,
    after: null,
    change: { kind: 'open-workspace' },
  });
  for (const [personId, role] of [
    ['person-dana', 'owner'],
    ['person-eli', 'admin'],
    ['person-fay', 'member'],
  ] as const) {
    sequence += 1;
    await workspaceCopies.applyAfter({
      workspaceId: 'acme',
      sequence,
      after: sequence - 1,
      change: { kind: 'put-member', personId, role },
    });
  }
}

const dana = () => caller('person-dana', 'owner');
const eli = () => caller('person-eli', 'admin');
const fay = () => caller('person-fay', 'member');

async function platform() {
  const answer = await createTeam(teams, dana(), { name: 'Platform' });
  if (answer.kind !== 'created') throw new Error(`Platform was not made: ${answer.kind}`);
  return answer.team;
}

describe('listTeams', () => {
  it('shows owners and admins every team, and that they manage them', async () => {
    await acme();
    const made = await platform();
    for (const who of [dana(), eli()]) {
      const answer = await listTeams(teams, who);
      expect(answer).toMatchObject({ kind: 'listed', canManage: true });
      expect(answer.kind === 'listed' && answer.teams.map((team) => team.name)).toEqual([
        FIRST_TEAM_NAME,
        made.name,
      ]);
    }
  });

  it('shows a member the teams they are in, and that they do not manage them', async () => {
    await acme();
    await platform();
    const answer = await listTeams(teams, fay());
    expect(answer).toMatchObject({ kind: 'listed', canManage: false });
    expect(answer.kind === 'listed' && answer.teams.map((team) => team.name)).toEqual([
      FIRST_TEAM_NAME,
    ]);
  });

  it('is pending while the cell does not hold the workspace', async () => {
    expect(await listTeams(teams, dana())).toEqual({ kind: 'workspace-pending' });
  });

  it("never reads another workspace's teams", async () => {
    await acme();
    await platform();
    await workspaceCopies.applyAfter({
      workspaceId: 'sprocket',
      sequence: 1,
      after: null,
      change: { kind: 'open-workspace' },
    });
    await workspaceCopies.applyAfter({
      workspaceId: 'sprocket',
      sequence: 2,
      after: 1,
      change: { kind: 'put-member', personId: 'person-dana', role: 'owner' },
    });
    const answer = await listTeams(teams, caller('person-dana', 'owner', 'sprocket'));
    expect(answer.kind === 'listed' && answer.teams.map((team) => team.name)).toEqual([
      FIRST_TEAM_NAME,
    ]);
  });
});

describe('changing teams', () => {
  it('is for owners and admins: a member is refused before anything else is read', async () => {
    // Not even the workspace is held, and the name is no name: the role is judged first.
    expect(await createTeam(teams, fay(), { name: '' })).toEqual({ kind: 'not-allowed' });
    expect(await renameTeam(teams, fay(), 'x', { name: '' })).toEqual({ kind: 'not-allowed' });
    expect(await deleteTeam(teams, fay(), 'x')).toEqual({ kind: 'not-allowed' });
    expect(await addTeamMember(teams, fay(), 'x', 'person-fay')).toEqual({ kind: 'not-allowed' });
    expect(await removeTeamMember(teams, fay(), 'x', 'person-fay')).toEqual({
      kind: 'not-allowed',
    });
  });

  it('names every problem with a name before asking whether the workspace is held', async () => {
    expect(await createTeam(teams, eli(), { name: ' ' })).toEqual({
      kind: 'invalid',
      problems: ['name_missing'],
    });
    expect(await renameTeam(teams, eli(), 'x', { name: 'a'.repeat(TEAM_NAME_MAX + 1) })).toEqual({
      kind: 'invalid',
      problems: ['name_too_long'],
    });
    expect(await createTeam(teams, eli(), { name: 'Platform' })).toEqual({
      kind: 'workspace-pending',
    });
    expect(await deleteTeam(teams, eli(), 'x')).toEqual({ kind: 'workspace-pending' });
    expect(await addTeamMember(teams, eli(), 'x', 'p')).toEqual({ kind: 'workspace-pending' });
  });

  it('makes, renames and deletes a team, keeping names unique in any case', async () => {
    await acme();
    const made = await platform();
    expect(made).toMatchObject({ name: 'Platform', first: false, memberIds: [] });
    expect(await createTeam(teams, eli(), { name: ' platform ' })).toEqual({ kind: 'name-taken' });
    expect(await renameTeam(teams, eli(), made.id, { name: '  Apps ' })).toEqual({
      kind: 'renamed',
      team: { ...made, name: 'Apps' },
    });
    expect(await deleteTeam(teams, eli(), made.id)).toEqual({ kind: 'deleted' });
    expect(await deleteTeam(teams, eli(), made.id)).toEqual({ kind: 'not-found' });
  });

  it('never deletes the first team', async () => {
    await acme();
    const listed = await listTeams(teams, dana());
    const first = listed.kind === 'listed' ? listed.teams[0] : undefined;
    expect(await deleteTeam(teams, dana(), first?.id ?? '')).toEqual({ kind: 'first-team' });
  });

  it('never deletes a team that owns a factory', async () => {
    await acme();
    const made = await platform();
    const { factories } = createDrizzleStores(db);
    await factories.create('acme', { name: 'Deploys', teamId: made.id, personId: 'person-dana' });
    expect(await deleteTeam(teams, dana(), made.id)).toEqual({ kind: 'owns-factories' });
  });

  it('judge a token older than the copy by the lesser of the two roles', async () => {
    await acme();
    const made = await platform();
    const apply = (sequence: number, change: CopyChange) =>
      workspaceCopies.applyAfter({ workspaceId: 'acme', sequence, after: sequence - 1, change });
    // Since their tokens were minted: Eli was made a member, and Dana left the workspace.
    await apply(5, { kind: 'put-member', personId: 'person-eli', role: 'member' });
    await apply(6, { kind: 'drop-member', personId: 'person-dana' });

    for (const stale of [eli(), dana()]) {
      expect(await createTeam(teams, stale, { name: 'Apps' })).toEqual({ kind: 'not-allowed' });
      expect(await renameTeam(teams, stale, made.id, { name: 'Apps' })).toEqual({
        kind: 'not-allowed',
      });
      expect(await deleteTeam(teams, stale, made.id)).toEqual({ kind: 'not-allowed' });
      expect(await addTeamMember(teams, stale, made.id, 'person-fay')).toEqual({
        kind: 'not-allowed',
      });
      expect(await removeTeamMember(teams, stale, made.id, 'person-fay')).toEqual({
        kind: 'not-allowed',
      });
    }
    // Eli sees what a member sees; Dana, in no team any more, sees none.
    const seenByEli = await listTeams(teams, eli());
    expect(seenByEli).toMatchObject({ kind: 'listed', canManage: false });
    expect(seenByEli.kind === 'listed' && seenByEli.teams.map((team) => team.name)).toEqual([
      FIRST_TEAM_NAME,
    ]);
    expect(await listTeams(teams, dana())).toEqual({ kind: 'listed', teams: [], canManage: false });

    // A promotion counts once the copy has it too: Fay's new token alone is not enough.
    const promoted = caller('person-fay', 'admin');
    expect(await createTeam(teams, promoted, { name: 'Apps' })).toEqual({ kind: 'not-allowed' });
    await apply(7, { kind: 'put-member', personId: 'person-fay', role: 'admin' });
    expect(await createTeam(teams, promoted, { name: 'Apps' })).toMatchObject({ kind: 'created' });
  });

  it("adds only the workspace's members, and takes people out", async () => {
    await acme();
    const made = await platform();
    expect(await addTeamMember(teams, eli(), made.id, 'person-gus')).toEqual({
      kind: 'not-a-member',
    });
    expect(await addTeamMember(teams, eli(), made.id, 'person-fay')).toEqual({
      kind: 'changed',
      team: { ...made, memberIds: ['person-fay'] },
    });
    expect(await removeTeamMember(teams, eli(), made.id, 'person-fay')).toEqual({
      kind: 'changed',
      team: made,
    });
    expect(await removeTeamMember(teams, eli(), 'no-such-team', 'person-fay')).toEqual({
      kind: 'not-found',
    });
  });
});
