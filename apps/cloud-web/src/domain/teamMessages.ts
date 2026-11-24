import { messageForCellRefusal } from './cell';
import { TEAM_NAME_MAX } from './teams';
import type { TeamChange, TeamProblem, TeamsState } from './teams';

/** What the Teams page says, for each rule and each answer. */

export const TEAMS_INTRO = 'Teams own factories.';

/** Who joins the first team, said beside it. */
export function firstTeamNote(workspaceName: string): string {
  return `Everyone who joins ${workspaceName} joins this team.`;
}

export const MEMBER_VIEW_NOTE =
  'You see the teams you’re in. Owners and admins make teams and choose who is in them.';

export const NO_TEAMS_FOR_MEMBER = 'You’re not in a team yet.';

const PROBLEMS: Record<TeamProblem, string> = {
  name_missing: 'Give the team a name.',
  name_too_long: `Keep the name to ${TEAM_NAME_MAX} characters.`,
  name_invalid: 'Use a name without line breaks or tabs.',
};

export function messageForTeamProblem(problem: TeamProblem): string {
  return PROBLEMS[problem];
}

/** Why a team's state could not be shown, for the workspace and its region. */
export function messageForTeamsState(
  state: Exclude<TeamsState, { kind: 'listed' }>,
  workspace: { name: string; region: string },
): string {
  return messageForCellRefusal(state, workspace);
}

/** What a change that did not go through says, or null for one that did. */
export function messageForTeamChange(
  change: TeamChange,
  workspace: { name: string; region: string },
): string | null {
  switch (change.kind) {
    case 'changed':
      return null;
    case 'invalid':
      return change.problems.map(messageForTeamProblem).join(' ') || 'That name can’t be used.';
    case 'name-taken':
      return 'Another team already has that name.';
    case 'not-allowed':
      return 'Only owners and admins can change teams.';
    case 'not-found':
      return 'That team was deleted. The list is up to date now.';
    case 'first-team':
      return 'The first team can’t be deleted: everyone who joins the workspace joins it.';
    case 'not-a-member':
      return 'That person isn’t a member of this workspace any more.';
    case 'pending':
    case 'switched':
    case 'signed-out':
    case 'unavailable':
      return messageForTeamsState(change, workspace);
  }
}
