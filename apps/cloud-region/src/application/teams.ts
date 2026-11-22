import type { Caller } from '../domain/caller.js';
import {
  actingRole,
  checkTeamName,
  mayManageTeams,
  type Team,
  type TeamProblem,
  teamsSeenBy,
} from '../domain/team.js';
import type { TeamStore } from './ports.js';

/*
 * A workspace's teams, for the caller a cell token names. Every use case reads and writes the
 * caller's workspace alone (`caller.workspaceId`), and judges what the caller may do by the
 * lesser of the role their token carries and the role the cell's copy holds (`actingRole`): a
 * token lives minutes, so someone demoted or removed since it was minted acts as they are now.
 *
 * A change answers in the order it checks: whether the token's role may do it (refused without
 * reading anything), whether what was sent reads, whether the cell holds the workspace yet,
 * whether the caller's role in the copy may do it too, and only then what the store finds.
 */

/** Whether the caller manages teams now, by their token's role and their role in the copy. */
async function managesNow(teams: TeamStore, caller: Caller): Promise<boolean> {
  const role = actingRole(caller.role, await teams.roleInCopy(caller.workspaceId, caller.personId));
  return role !== null && mayManageTeams(role);
}

/** A refusal every change of a team can give. */
type Refusal =
  /** The caller's role, in their token or in the cell's copy, does not manage teams. */
  | { kind: 'not-allowed' }
  /**
   * The cell does not hold the workspace yet: `cloud-global` has not delivered its
   * `workspace.created`, so it has no first team either. It will, so asking again later helps.
   */
  | { kind: 'workspace-pending' };

const NOT_ALLOWED = { kind: 'not-allowed' } as const;
const WORKSPACE_PENDING = { kind: 'workspace-pending' } as const;

export type TeamsList =
  | {
      kind: 'listed';
      /** The teams the caller sees (`teamsSeenBy`). */
      teams: Team[];
      /** Whether the caller may make, rename and delete teams, and choose their members. */
      canManage: boolean;
    }
  | { kind: 'workspace-pending' };

/**
 * The teams the caller sees: every team for those who manage them, else the caller's own. A
 * caller the copy holds no member of is in no team, so sees none.
 */
export async function listTeams(teams: TeamStore, caller: Caller): Promise<TeamsList> {
  const { workspaceId, personId } = caller;
  if (!(await teams.holdsWorkspace(workspaceId))) return WORKSPACE_PENDING;
  const role = actingRole(caller.role, await teams.roleInCopy(workspaceId, personId));
  const viewer = { personId, role: role ?? 'member' };
  return {
    kind: 'listed',
    teams: teamsSeenBy(viewer, await teams.list(workspaceId)),
    canManage: role !== null && mayManageTeams(role),
  };
}

export type TeamCreation =
  | { kind: 'created'; team: Team }
  | Refusal
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
  if (!(await teams.holdsWorkspace(caller.workspaceId))) return WORKSPACE_PENDING;
  if (!(await managesNow(teams, caller))) return NOT_ALLOWED;

  const team = await teams.create(caller.workspaceId, name.name);
  return team === 'name-taken' ? { kind: 'name-taken' } : { kind: 'created', team };
}

export type TeamRename =
  | { kind: 'renamed'; team: Team }
  | Refusal
  | { kind: 'invalid'; problems: TeamProblem[] }
  | { kind: 'not-found' }
  | { kind: 'name-taken' };

/** Gives a team of the caller's workspace a new name. The first team can be renamed too. */
export async function renameTeam(
  teams: TeamStore,
  caller: Caller,
  teamId: string,
  input: { name: string },
): Promise<TeamRename> {
  if (!mayManageTeams(caller.role)) return NOT_ALLOWED;
  const name = checkTeamName(input.name);
  if (!name.ok) return { kind: 'invalid', problems: name.problems };
  if (!(await teams.holdsWorkspace(caller.workspaceId))) return WORKSPACE_PENDING;
  if (!(await managesNow(teams, caller))) return NOT_ALLOWED;

  const team = await teams.rename(caller.workspaceId, teamId, name.name);
  if (team === 'not-found' || team === 'name-taken') return { kind: team };
  return { kind: 'renamed', team };
}

export type TeamDeletion =
  | { kind: 'deleted' }
  | Refusal
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
  if (!(await teams.holdsWorkspace(caller.workspaceId))) return WORKSPACE_PENDING;
  if (!(await managesNow(teams, caller))) return NOT_ALLOWED;

  const answer = await teams.remove(caller.workspaceId, teamId);
  return answer === 'removed' ? { kind: 'deleted' } : { kind: answer };
}

export type TeamMembership =
  | { kind: 'changed'; team: Team }
  | Refusal
  | { kind: 'not-found' }
  /** The person is not a member of the workspace, as far as the cell's copy knows. */
  | { kind: 'not-a-member' };

/**
 * Makes a member of the caller's workspace a member of one of its teams. Only the workspace's
 * members can be, by their global id; one already in the team stays as they are.
 */
export async function addTeamMember(
  teams: TeamStore,
  caller: Caller,
  teamId: string,
  personId: string,
): Promise<TeamMembership> {
  if (!mayManageTeams(caller.role)) return NOT_ALLOWED;
  if (!(await teams.holdsWorkspace(caller.workspaceId))) return WORKSPACE_PENDING;
  if (!(await managesNow(teams, caller))) return NOT_ALLOWED;

  const team = await teams.addMember(caller.workspaceId, teamId, personId);
  if (team === 'not-found' || team === 'not-a-member') return { kind: team };
  return { kind: 'changed', team };
}

/** Takes a person out of a team of the caller's workspace. Someone not in it changes nothing. */
export async function removeTeamMember(
  teams: TeamStore,
  caller: Caller,
  teamId: string,
  personId: string,
): Promise<Exclude<TeamMembership, { kind: 'not-a-member' }>> {
  if (!mayManageTeams(caller.role)) return NOT_ALLOWED;
  if (!(await teams.holdsWorkspace(caller.workspaceId))) return WORKSPACE_PENDING;
  if (!(await managesNow(teams, caller))) return NOT_ALLOWED;

  const team = await teams.removeMember(caller.workspaceId, teamId, personId);
  return team === 'not-found' ? { kind: 'not-found' } : { kind: 'changed', team };
}
