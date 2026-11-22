import createClient, { type Client } from 'openapi-fetch';
import type { paths } from '../domain/cellApiContract';
import {
  isTeamProblem,
  type TeamChange,
  type TeamsState,
  type WorkspaceMember,
} from '../domain/teams';
import { type Api, createApi } from './api';

/*
 * A workspace's teams, from its regional cell. The page reaches a region's cell at
 * `/cell/<region>` on its own origin, which the dev server proxies to it (`vite.config.ts`). The
 * cell takes no cookie: every call carries a cell token `cloud-global` mints for the session's
 * active workspace (`POST /api/cell-token`), as `Authorization: Bearer`.
 *
 * The token names the workspace it is for, and a call goes ahead only when that is the workspace
 * the page shows: another tab can switch the session's workspace, and a token for that one would
 * read and change its teams under this one's name (`switched`). A token is kept until shortly
 * before it expires, and one the cell refuses is minted again once, for a clock out of step.
 *
 * Every call answers in domain types. Only a 401 from `cloud-global` means signed out; anything
 * the calls do not expect, a cell that does not answer included, is `unavailable`.
 */

/** A request as `openapi-fetch` sends it. */
type Fetch = (request: Request) => Promise<Response>;

/** A client of a cell's API, typed by its contract, sending one token. */
export type CellApi = Client<paths>;

/** Where the page reaches a region's cell: `origin` is empty in the page, absolute in a test. */
export function cellBaseUrl(region: string, origin = ''): string {
  return `${origin}/cell/${region}`;
}

/** A client of the cell at `baseUrl`, sending `token` with every request. */
export function createCellApi(options: { token: string; baseUrl: string; fetch?: Fetch }): CellApi {
  const client = createClient<paths>({ baseUrl: options.baseUrl, fetch: options.fetch });
  client.use({
    onRequest({ request }) {
      request.headers.set('authorization', `Bearer ${options.token}`);
      return request;
    },
  });
  return client;
}

/** A token is minted again this long before it expires, so none expires on its way. */
const EARLY_SECONDS = 30;

type Grant = { token: string; expiresAt: number; workspaceId: string; region: string };

type Refusal = Extract<TeamsState, { kind: 'pending' | 'switched' | 'signed-out' | 'unavailable' }>;

const UNAVAILABLE = { kind: 'unavailable' } as const;
const SWITCHED = { kind: 'switched' } as const;
const PENDING = { kind: 'pending' } as const;
const CHANGED = { kind: 'changed' } as const;

/** The `error` code of an answer's body, if it has one. */
function codeOf(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
}

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

/**
 * The teams service, holding the token it last minted. The page uses `teamsService`; a test
 * builds its own with `cloud-global`'s client and the cell's `fetch` stood in for, and an origin
 * to resolve the cell's address against.
 */
export function createTeamsService(
  deps: { api?: Api; cellFetch?: Fetch; cellOrigin?: string; nowSeconds?: () => number } = {},
): TeamsService {
  const api = deps.api ?? createApi();
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  let grant: Grant | null = null;

  /** A token for `workspaceId`, kept or minted, or why there is none. */
  async function grantFor(workspaceId: string): Promise<Grant | Refusal> {
    if (
      grant &&
      grant.workspaceId === workspaceId &&
      grant.expiresAt - EARLY_SECONDS > nowSeconds()
    ) {
      return grant;
    }
    grant = null;
    const { data, error, response } = await api.POST('/api/cell-token');
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 200 && data) {
      if (data.workspaceId !== workspaceId) return SWITCHED;
      grant = data;
      return data;
    }
    // The session has no workspace open, or one the person has left: not the page's any more.
    const code = codeOf(error);
    if (code === 'no_active_workspace' || code === 'not_a_member') return SWITCHED;
    return UNAVAILABLE;
  }

  /**
   * Runs `call` on the workspace's cell with a token for it. A token the cell refuses (401) is
   * minted again once; refused again, the cell is not one this page can use.
   */
  async function onCell<Answer extends { response: Response }>(
    workspaceId: string,
    call: (cell: CellApi) => Promise<Answer>,
  ): Promise<Answer | Refusal> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const granted = await grantFor(workspaceId);
      if ('kind' in granted) return granted;
      const cell = createCellApi({
        token: granted.token,
        baseUrl: cellBaseUrl(granted.region, deps.cellOrigin),
        fetch: deps.cellFetch,
      });
      const answer = await call(cell);
      if (answer.response.status !== 401) return answer;
      grant = null;
    }
    return UNAVAILABLE;
  }

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
      if (code === 'workspace_pending') return PENDING;
    }
    return UNAVAILABLE;
  }

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
  async function membersOf(): Promise<WorkspaceMember[] | Refusal> {
    const { data, error, response } = await api.GET('/api/me/workspace/members');
    if (response.status === 401) return { kind: 'signed-out' };
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
export const teamsService = createTeamsService();
