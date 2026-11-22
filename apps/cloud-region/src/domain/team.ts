import type { WorkspaceRole } from '@consola/cloud-contract';

/**
 * Teams inside a workspace, held in its region's cell: names are the company's information, so
 * they never reach `cloud-global`. A team's members are members of its workspace, by global id.
 *
 * A workspace has a first team from the moment the cell holds it: the cell makes it as it applies
 * `workspace.created`, and adds to it every person who becomes a member of the workspace. So a
 * company that never sets teams up still has one team holding everyone, and every factory has a
 * team to belong to. The first team can be renamed, and its members removed, but it is never
 * deleted, which keeps that true.
 *
 * There are no team roles: owners and admins of the workspace manage its teams, and a member
 * sees the teams they are in. A person acts with the lesser of their token's role and the role
 * the cell's copy holds (`actingRole`).
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
 * problem is named at once. Names are unique in a workspace whatever their case, which the cell's
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

/** How much each role may do: the lower, the less. */
const ROLE_RANK: Record<WorkspaceRole, number> = { member: 0, admin: 1, owner: 2 };

/**
 * The role a person acts with: the lesser of the role their token carries and the role the
 * cell's copy holds, or null when the copy holds no such member. A token lives minutes and the
 * copy follows `cloud-global` within moments, so a person demoted or removed since their token was
 * minted acts as they are now, never as they were; and one promoted acts with the new role only
 * once both say so.
 */
export function actingRole(
  tokenRole: WorkspaceRole,
  copyRole: WorkspaceRole | null,
): WorkspaceRole | null {
  if (copyRole === null) return null;
  return ROLE_RANK[copyRole] < ROLE_RANK[tokenRole] ? copyRole : tokenRole;
}

/** A team as the cell holds it. */
export type Team = {
  /** The team's id, which the cell gives it. */
  readonly id: string;
  readonly name: string;
  /** Whether it is the workspace's first team, which every new member joins. */
  readonly first: boolean;
  /** The global ids of its members, in the order they joined it. */
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
