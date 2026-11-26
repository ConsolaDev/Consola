import { isTeamProblem } from '../domain/teams';
import type { TeamChange, TeamsState, WorkspaceMember } from '../domain/teams';
import {
  codeOf,
  createCellSession,
  PENDING,
  pageCellSession,
  SIGNED_OUT,
  SWITCHED,
  UNAVAILABLE,
} from './cell';
import type { CellApi, CellDeps, CellRefusal, CellSession } from './cell';

/*
 * A workspace's teams, from its regional cell (`cell.ts`: the token, the address, the states a
 * cell answers), and its members from `cloud-global`, to name the people in them. Every call
 * answers in domain types. Only a 401 from `cloud-global` means signed out; anything the calls do
 * not expect, a cell that does not answer included, is `unavailable`.
 */

const CHANGED = { kind: 'changed' } as const;

export type TeamsService = {
  /** The teams the person sees in `workspace`, with its members to name the people in them. */
  loadTeams(workspace: { id: string }): Promise<TeamsState>;
  createTeam(workspace: { id: string }, name: string): Promise<TeamChange>;
  renameTeam(workspace: { id: string }, teamId: string, name: string): Promise<TeamChange>;
  deleteTeam(workspace: { id: string }, teamId: string): Promise<TeamChange>;
  addTeamMember(workspace: { id: string }, teamId: string, personId: string): Promise<TeamChange>;
  removeTeamMember(
    workspace: { id: string },
    teamId: string,
    personId: string,
  ): Promise<TeamChange>;
};

/** What a change's answer comes to, for the statuses every change shares. */
function changeOf(answer: { error?: unknown; response: Response } | CellRefusal): TeamChange {
  if ('kind' in answer) return answer;
  const { status } = answer.response;
  const code = codeOf(answer.error);
  if (status >= 200 && status < 300) return CHANGED;
  if (status === 400 && code === 'invalid_team') {
    const problems = (answer.error as { problems?: unknown }).problems;
    return {
      kind: 'invalid',
      problems: Array.isArray(problems) ? problems.filter(isTeamProblem) : [],
    };
  }
  if (status === 403 && code === 'not_allowed') return { kind: 'not-allowed' };
  if (status === 404 && code === 'team_not_found') return { kind: 'not-found' };
  if (status === 409) {
    if (code === 'name_taken') return { kind: 'name-taken' };
    if (code === 'first_team') return { kind: 'first-team' };
    if (code === 'not_a_workspace_member') return { kind: 'not-a-member' };
    if (code === 'workspace_pending') return PENDING;
  }
  return UNAVAILABLE;
}

/**
 * The teams service. The page uses `teamsService`, on the page's way to its cell; a test builds
 * its own with `cloud-global`'s client and the cell's `fetch` stood in for, and an origin to
 * resolve the cell's address against.
 */
export function createTeamsService(deps: CellDeps & { session?: CellSession } = {}): TeamsService {
  const session = deps.session ?? createCellSession(deps);
  const { api, onCell } = session;

  /** Runs a change on the cell, answering how it went, and never throwing. */
  async function change(
    workspaceId: string,
    call: (cell: CellApi) => Promise<{ error?: unknown; response: Response }>,
  ): Promise<TeamChange> {
    try {
      return changeOf(await onCell(workspaceId, call));
    } catch {
      return UNAVAILABLE;
    }
  }

  /** The workspace's members from `cloud-global`, or why they could not be had. */
  async function membersOf(): Promise<WorkspaceMember[] | CellRefusal> {
    const { data, error, response } = await api.GET('/api/me/workspace/members');
    if (response.status === 401) return SIGNED_OUT;
    if (response.status === 200 && Array.isArray(data?.members)) return data.members;
    const code = codeOf(error);
    if (code === 'no_active_workspace' || code === 'not_a_member') return SWITCHED;
    return UNAVAILABLE;
  }

  return {
    async loadTeams(workspace) {
      try {
        const [teams, members] = await Promise.all([
          onCell(workspace.id, (cell) => cell.GET('/api/teams')),
          membersOf(),
        ]);
        if ('kind' in members) return members;
        if ('kind' in teams) return teams;
        const { data, error, response } = teams;
        if (response.status === 200 && data && Array.isArray(data.teams)) {
          return { kind: 'listed', teams: data.teams, canManage: data.canManage, members };
        }
        if (response.status === 409 && codeOf(error) === 'workspace_pending') return PENDING;
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    createTeam(workspace, name) {
      return change(workspace.id, (cell) => cell.POST('/api/teams', { body: { name } }));
    },

    renameTeam(workspace, teamId, name) {
      return change(workspace.id, (cell) =>
        cell.PATCH('/api/teams/{teamId}', { params: { path: { teamId } }, body: { name } }),
      );
    },

    deleteTeam(workspace, teamId) {
      return change(workspace.id, (cell) =>
        cell.DELETE('/api/teams/{teamId}', { params: { path: { teamId } } }),
      );
    },

    addTeamMember(workspace, teamId, personId) {
      return change(workspace.id, (cell) =>
        cell.PUT('/api/teams/{teamId}/members/{personId}', {
          params: { path: { teamId, personId } },
        }),
      );
    },

    removeTeamMember(workspace, teamId, personId) {
      return change(workspace.id, (cell) =>
        cell.DELETE('/api/teams/{teamId}/members/{personId}', {
          params: { path: { teamId, personId } },
        }),
      );
    },
  };
}

/** The page's teams service. */
export const teamsService = createTeamsService({ session: pageCellSession });
