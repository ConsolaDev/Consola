import type { WorkspaceRole } from '../../shared/workspaceRole.js';

/**
 * Teams inside a workspace: their names are the company's information. A team's members are
 * members of its workspace, by id.
 *
 * A workspace has a first team from the moment it exists: the transaction that makes the
 * workspace makes the team and puts its owner in it (`openWorkspace`). So a company that never
 * sets teams up still has one team, and every factory has a team to belong to. The first team can
 * be renamed, and its members removed, but it is never deleted, which keeps that true.
 *
 * There are no team roles: owners and admins of the workspace manage its teams, and a member
 * sees the teams they are in. A person acts with their role in the workspace as accounts' `member`
 * holds it at this request (`Caller.role`), so someone demoted or removed acts as they are now.
 */

/** What the first team is called, until someone renames it. */
export const FIRST_TEAM_NAME = 'General';

/** The longest a team's name may be, in characters, once trimmed. */
export const TEAM_NAME_MAX = 64;

export const TEAM_PROBLEMS = ['name_missing', 'name_too_long', 'name_invalid'] as const;

/** Why a team's name is refused. */
export type TeamProblem = (typeof TEAM_PROBLEMS)[number];

/** A control character: a line break, a tab, an escape. No list of teams can show one. */
const CONTROL = /\p{Cc}/u;

/**
 * A team's name, trimmed, when it is one: between 1 and `TEAM_NAME_MAX` characters
 * (`name_missing`, `name_too_long`), with no control character in it (`name_invalid`). Every
 * problem is named at once. Names are unique in a workspace whatever their case, which the team
 * store holds (`name-taken`), since only it sees every team at once.
 */
export function checkTeamName(
  name: string,
): { ok: true; name: string } | { ok: false; problems: TeamProblem[] } {
  const trimmed = name.trim();
  if (trimmed === '') return { ok: false, problems: ['name_missing'] };
  const problems: TeamProblem[] = [];
  if ([...trimmed].length > TEAM_NAME_MAX) problems.push('name_too_long');
  if (CONTROL.test(trimmed)) problems.push('name_invalid');
  return problems.length === 0 ? { ok: true, name: trimmed } : { ok: false, problems };
}

/** Whether a role may make, rename and delete a workspace's teams, and choose their members. */
export function mayManageTeams(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin';
}

/** A team as the company holds it. */
export type Team = {
  /** The team's id, which the company gives it. */
  readonly id: string;
  readonly name: string;
  /** Whether it is the workspace's first team, which every new member joins. */
  readonly first: boolean;
  /** Its members' ids, in the order they joined it. */
  readonly memberIds: string[];
};

/**
 * The teams a person sees: every team of the workspace for those who manage teams, and only the
 * ones they are in for everyone else.
 */
export function teamsSeenBy(
  person: { personId: string; role: WorkspaceRole },
  teams: readonly Team[],
): Team[] {
  if (mayManageTeams(person.role)) return [...teams];
  return teams.filter((team) => team.memberIds.includes(person.personId));
}

/**
 * The team with only the places of people `members` lists: the workspace's members now, as
 * accounts' `member` holds them. A place has no foreign key to `member`, so it outlives a person
 * who leaves the workspace until something takes them out of every team; no answer shows them as a
 * team's member meanwhile. The order they joined in stays.
 */
export function withCurrentMembers(team: Team, members: ReadonlySet<string>): Team {
  return { ...team, memberIds: team.memberIds.filter((personId) => members.has(personId)) };
}
