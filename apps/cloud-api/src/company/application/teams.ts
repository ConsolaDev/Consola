import type { Caller } from '../domain/caller.js';
import { checkTeamName, mayManageTeams, teamsSeenBy, withCurrentMembers } from '../domain/team.js';
import type { Team, TeamProblem } from '../domain/team.js';
import type { MembershipReader, TeamStore } from './ports.js';

/*
 * A workspace's teams, for the caller a request's session names. Every use case reads and writes
 * the caller's workspace alone (`caller.workspaceId`), and judges what the caller may do by their
 * role there (`caller.role`), read from accounts' `member` for this request: someone demoted or
 * removed acts as they are now.
 *
 * A change answers in the order it checks: whether the caller's role may do it (refused without
 * reading anything), whether what was sent reads, and only then what the store finds. Every team
 * an answer holds lists only people who are members of the workspace now (`shown`).
 */

/**
 * The teams as an answer shows them: with the places of the workspace's members now alone
 * (`withCurrentMembers`), so someone who left the workspace is never listed in one of its teams.
 */
async function shown(
  membership: MembershipReader,
  workspaceId: string,
  teams: readonly Team[],
): Promise<Team[]> {
  const members = new Set(await membership.memberIds(workspaceId));
  return teams.map((team) => withCurrentMembers(team, members));
}

/** One team, as `shown` shows it. */
async function shownTeam(membership: MembershipReader, workspaceId: string, team: Team) {
  const [only] = await shown(membership, workspaceId, [team]);
  return only ?? team;
}

/** The caller's role does not manage teams. */
type NotAllowed = { kind: 'not-allowed' };
const NOT_ALLOWED: NotAllowed = { kind: 'not-allowed' };

export type TeamsList = {
  kind: 'listed';
  /** The teams the caller sees (`teamsSeenBy`). */
  teams: Team[];
  /** Whether the caller may make, rename and delete teams, and choose their members. */
  canManage: boolean;
};

/** The teams the caller sees: every team for those who manage them, else the caller's own. */
export async function listTeams(
  teams: TeamStore,
  membership: MembershipReader,
  caller: Caller,
): Promise<TeamsList> {
  const { workspaceId } = caller;
  const seen = teamsSeenBy(caller, await teams.list(workspaceId));
  return {
    kind: 'listed',
    teams: await shown(membership, workspaceId, seen),
    canManage: mayManageTeams(caller.role),
  };
}

export type TeamCreation =
  | { kind: 'created'; team: Team }
  | NotAllowed
  | { kind: 'invalid'; problems: TeamProblem[] }
  | { kind: 'name-taken' };

/** Makes a team in the caller's workspace, with nobody in it yet. */
export async function createTeam(
  teams: TeamStore,
  caller: Caller,
  input: { name: string },
): Promise<TeamCreation> {
  if (!mayManageTeams(caller.role)) return NOT_ALLOWED;
  const name = checkTeamName(input.name);
  if (!name.ok) return { kind: 'invalid', problems: name.problems };

  const team = await teams.create(caller.workspaceId, name.name);
  return team === 'name-taken' ? { kind: 'name-taken' } : { kind: 'created', team };
}

export type TeamRename =
  | { kind: 'renamed'; team: Team }
  | NotAllowed
  | { kind: 'invalid'; problems: TeamProblem[] }
  | { kind: 'not-found' }
  | { kind: 'name-taken' };

/** Gives a team of the caller's workspace a new name. The first team can be renamed too. */
export async function renameTeam(
  teams: TeamStore,
  membership: MembershipReader,
  caller: Caller,
  teamId: string,
  input: { name: string },
): Promise<TeamRename> {
  if (!mayManageTeams(caller.role)) return NOT_ALLOWED;
  const name = checkTeamName(input.name);
  if (!name.ok) return { kind: 'invalid', problems: name.problems };

  const team = await teams.rename(caller.workspaceId, teamId, name.name);
  if (team === 'not-found' || team === 'name-taken') return { kind: team };
  return { kind: 'renamed', team: await shownTeam(membership, caller.workspaceId, team) };
}

export type TeamDeletion =
  | { kind: 'deleted' }
  | NotAllowed
  | { kind: 'not-found' }
  /** The workspace's first team, which is never deleted. */
  | { kind: 'first-team' }
  /** A team that owns a factory, which is not deleted while it does. */
  | { kind: 'owns-factories' };

/** Deletes a team of the caller's workspace, unless it is the first team or owns a factory. */
export async function deleteTeam(
  teams: TeamStore,
  caller: Caller,
  teamId: string,
): Promise<TeamDeletion> {
  if (!mayManageTeams(caller.role)) return NOT_ALLOWED;

  const answer = await teams.remove(caller.workspaceId, teamId);
  return answer === 'removed' ? { kind: 'deleted' } : { kind: answer };
}

export type TeamMembership =
  | { kind: 'changed'; team: Team }
  | NotAllowed
  | { kind: 'not-found' }
  /** The person is not a member of the workspace, as accounts' `member` holds it now. */
  | { kind: 'not-a-member' };

/**
 * Makes a member of the caller's workspace a member of one of its teams. Only the workspace's
 * members can be, by their id: whether the person is one is asked of accounts' `member`
 * (`membership`) before the place is written, since no foreign key reaches it. One already in the
 * team stays as they are.
 */
export async function addTeamMember(
  teams: TeamStore,
  membership: MembershipReader,
  caller: Caller,
  teamId: string,
  personId: string,
): Promise<TeamMembership> {
  if (!mayManageTeams(caller.role)) return NOT_ALLOWED;
  if ((await membership.roleOf(personId, caller.workspaceId)) === null) {
    return { kind: 'not-a-member' };
  }

  const team = await teams.addMember(caller.workspaceId, teamId, personId);
  if (team === 'not-found') return { kind: team };
  return { kind: 'changed', team: await shownTeam(membership, caller.workspaceId, team) };
}

/** Takes a person out of a team of the caller's workspace. Someone not in it changes nothing. */
export async function removeTeamMember(
  teams: TeamStore,
  membership: MembershipReader,
  caller: Caller,
  teamId: string,
  personId: string,
): Promise<Exclude<TeamMembership, { kind: 'not-a-member' }>> {
  if (!mayManageTeams(caller.role)) return NOT_ALLOWED;

  const team = await teams.removeMember(caller.workspaceId, teamId, personId);
  if (team === 'not-found') return { kind: 'not-found' };
  return { kind: 'changed', team: await shownTeam(membership, caller.workspaceId, team) };
}
