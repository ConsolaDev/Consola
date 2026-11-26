import type { components } from './apiContract';

/**
 * A workspace's teams as the web app sees them. They live in the workspace's regional cell,
 * which is the authority on every rule here: the web app imports no package, so it keeps its own
 * copy of the name rule, to check a name before sending it. When the cell disagrees, its answer
 * is what the page shows. The copies are checked against the cell's contract
 * (`cellApiContract.ts`) as the app typechecks.
 *
 * A team names its members by global id. Their names and emails are `cloud-global`'s, so the
 * page puts the two together (`memberOf`).
 */

export type Team = components['schemas']['Team'];

/** A member of the workspace, from `cloud-global`: who they are, and their role. */
export type WorkspaceMember = components['schemas']['WorkspaceMember'];

/** What the cell names as a problem with a team's name. */
export type TeamProblem = components['schemas']['InvalidTeam']['problems'][number];

/** Every problem the cell names; `teamMessages.ts` has a sentence for each, keyed by the type. */
const TEAM_PROBLEMS: Record<TeamProblem, true> = {
  name_missing: true,
  name_too_long: true,
  name_invalid: true,
};

export function isTeamProblem(value: unknown): value is TeamProblem {
  return typeof value === 'string' && Object.hasOwn(TEAM_PROBLEMS, value);
}

/** The longest a team's name may be, in characters, once trimmed. */
export const TEAM_NAME_MAX = 64;

const CONTROL = /\p{Cc}/u;

/**
 * A team's name, trimmed, when the cell would take it: 1 to `TEAM_NAME_MAX` characters with no
 * control character. Every problem is named at once. Whether another team has the name is the
 * cell's to say (`name-taken`).
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

/**
 * A team's member as the page shows them: the workspace member the id names, or, for an id
 * `cloud-global` no longer lists (someone who just left, whose leaving the cell has not heard
 * yet), the id alone.
 */
export type TeamMember =
  | { kind: 'member'; member: WorkspaceMember }
  | { kind: 'unknown'; personId: string };

export function memberOf(personId: string, members: readonly WorkspaceMember[]): TeamMember {
  const member = members.find((listed) => listed.id === personId);
  return member ? { kind: 'member', member } : { kind: 'unknown', personId };
}

/** The workspace's members not in the team, in the order they joined: who can be added. */
export function addableTo(team: Team, members: readonly WorkspaceMember[]): WorkspaceMember[] {
  return members.filter((member) => !team.memberIds.includes(member.id));
}

/** The teams the page shows, and what the person may do with them. */
export type TeamsState =
  | {
      kind: 'listed';
      teams: Team[];
      /** Whether the person may make, rename and delete teams and choose their members. */
      canManage: boolean;
      /** The workspace's members, to name the people in each team. */
      members: WorkspaceMember[];
    }
  /** The cell does not hold the workspace yet: `cloud-global` is still telling it. */
  | { kind: 'pending' }
  /** The session's workspace is not the one the page shows: another tab switched it. */
  | { kind: 'switched' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };

/** What a change to a team came to. */
export type TeamChange =
  | { kind: 'changed' }
  | { kind: 'invalid'; problems: TeamProblem[] }
  | { kind: 'name-taken' }
  /** The person's role does not manage teams, now. */
  | { kind: 'not-allowed' }
  /** The team is gone: someone else deleted it. */
  | { kind: 'not-found' }
  /** The workspace's first team, which is never deleted. */
  | { kind: 'first-team' }
  /** The person is not a member of the workspace, as far as its cell knows. */
  | { kind: 'not-a-member' }
  | { kind: 'pending' }
  | { kind: 'switched' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };
