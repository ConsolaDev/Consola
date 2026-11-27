import { isTeamProblem } from '../domain/teams';
import type { TeamChange, TeamsState, WorkspaceMember } from '../domain/teams';
import type { ApiOptions, Api } from './api';
import { codeOf, UNAVAILABLE, workspaceCalls } from './workspaceCalls';
import type { Refusal } from './workspaceCalls';

/*
 * A workspace's teams, and its members to name the people in them, from the API, for the
 * workspace the page shows (`workspaceCalls.ts`: the header, and the caller's refusals every
 * route shares). Every call answers in domain types and never throws. Only a 401 means signed
 * out; anything a call does not expect, an API that does not answer included, is `unavailable`.
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
function changeOf(answer: { error?: unknown; response: Response } | Refusal): TeamChange {
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
  }
  return UNAVAILABLE;
}

/**
 * The teams service. The page uses `teamsService`; a test builds its own with the API's `fetch`
 * stood in for, and an origin to resolve its address against.
 */
export function createTeamsService(options: ApiOptions = {}): TeamsService {
  const onWorkspace = workspaceCalls(options);

  /** Runs a change for the workspace, answering how it went, and never throwing. */
  async function change(
    workspaceId: string,
    call: (api: Api) => Promise<{ error?: unknown; response: Response }>,
  ): Promise<TeamChange> {
    try {
      return changeOf(await onWorkspace(workspaceId, call));
    } catch {
      return UNAVAILABLE;
    }
  }

  /** The workspace's members, or why they could not be had. */
  async function membersOf(workspaceId: string): Promise<WorkspaceMember[] | Refusal> {
    const answer = await onWorkspace(workspaceId, (api) => api.GET('/api/me/workspace/members'));
    if ('kind' in answer) return answer;
    const { data, response } = answer;
    if (response.status === 200 && Array.isArray(data?.members)) return data.members;
    return UNAVAILABLE;
  }

  return {
    async loadTeams(workspace) {
      try {
        const [teams, members] = await Promise.all([
          onWorkspace(workspace.id, (api) => api.GET('/api/teams')),
          membersOf(workspace.id),
        ]);
        if ('kind' in teams) return teams;
        if ('kind' in members) return members;
        const { data, response } = teams;
        if (response.status === 200 && data && Array.isArray(data.teams)) {
          return { kind: 'listed', teams: data.teams, canManage: data.canManage, members };
        }
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    createTeam(workspace, name) {
      return change(workspace.id, (api) => api.POST('/api/teams', { body: { name } }));
    },

    renameTeam(workspace, teamId, name) {
      return change(workspace.id, (api) =>
        api.PATCH('/api/teams/{teamId}', { params: { path: { teamId } }, body: { name } }),
      );
    },

    deleteTeam(workspace, teamId) {
      return change(workspace.id, (api) =>
        api.DELETE('/api/teams/{teamId}', { params: { path: { teamId } } }),
      );
    },

    addTeamMember(workspace, teamId, personId) {
      return change(workspace.id, (api) =>
        api.PUT('/api/teams/{teamId}/members/{personId}', {
          params: { path: { teamId, personId } },
        }),
      );
    },

    removeTeamMember(workspace, teamId, personId) {
      return change(workspace.id, (api) =>
        api.DELETE('/api/teams/{teamId}/members/{personId}', {
          params: { path: { teamId, personId } },
        }),
      );
    },
  };
}

/** The page's teams service. */
export const teamsService = createTeamsService();
