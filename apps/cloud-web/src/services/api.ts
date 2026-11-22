import createClient, { type Client } from 'openapi-fetch';
import type { paths } from '../domain/apiContract';
import type { MeState } from '../domain/me';
import {
  type CreateWorkspaceAnswer,
  isWorkspaceProblem,
  type NewWorkspace,
  type SwitchWorkspaceAnswer,
  type WorkspacesState,
} from '../domain/workspace';

/*
 * Every call here answers in domain types, and in each only a 401 means signed out: a failed
 * fetch, a status or a body the call does not expect, or a body that is not JSON is
 * `unavailable`, so a service that is down never looks like a signed-out person. A call that
 * changes something sends JSON from the page's own origin, which the browser names in `Origin`,
 * as the API requires.
 *
 * The client is typed by the API's contract (`domain/apiContract.ts`), so a path, a body or an
 * answer the API does not have fails the typecheck. The checks below are for what the types
 * cannot see: an answer from something that is not the API (a proxy's error page, say), or from
 * a newer API than this page was built against.
 */

/** A client of cloud-global's API, typed by its contract: every path, body and answer. */
export type Api = Client<paths>;

/** What the client sends its requests with: the browser's `fetch`, unless a test passes its own. */
type Send = (request: Request) => Promise<Response>;

/**
 * The API's client, and the only way a service reaches the API: no service calls `fetch` itself
 * (`boundary.test.ts`). The page and the API share one origin, through the dev server's /api
 * proxy, so its paths are relative. A test passes its own `fetch` and an absolute `baseUrl`,
 * since Node has no page to resolve a relative address against.
 */
export function createApi(options: { fetch?: Send; baseUrl?: string } = {}): Api {
  return createClient<paths>({
    baseUrl: options.baseUrl ?? '',
    fetch: options.fetch,
    credentials: 'same-origin',
  });
}

const api = createApi();

const UNAVAILABLE = { kind: 'unavailable' } as const;

/** Who is signed in, and the workspace their session has active. */
export async function loadMe(client: Api = api): Promise<MeState> {
  try {
    const { data, response } = await client.GET('/api/me');
    if (response.status === 401) return { kind: 'signed-out' };
    if (!response.ok || data === undefined) return UNAVAILABLE;
    return { kind: 'signed-in', me: data };
  } catch {
    return UNAVAILABLE;
  }
}

/** The person's workspaces, in the order they joined. */
export async function loadWorkspaces(client: Api = api): Promise<WorkspacesState> {
  try {
    const { data, response } = await client.GET('/api/workspaces');
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status !== 200 || !Array.isArray(data?.workspaces)) return UNAVAILABLE;
    return { kind: 'listed', workspaces: data.workspaces };
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * Makes a workspace, which the person's session then opens. The server checks the request
 * again: a problem it names that the page does not know is dropped, and `invalid` with none
 * left still means it refused.
 */
export async function createWorkspace(
  workspace: NewWorkspace,
  client: Api = api,
): Promise<CreateWorkspaceAnswer> {
  try {
    const { name, slug, region } = workspace;
    const { data, error, response } = await client.POST('/api/workspaces', {
      body: { name, slug, region },
    });
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 201 && data) return { kind: 'created', workspace: data };
    if (response.status === 409 && error?.error === 'slug_taken') return { kind: 'slug-taken' };
    if (
      response.status === 400 &&
      error?.error === 'invalid_workspace' &&
      Array.isArray(error.problems)
    ) {
      return { kind: 'invalid', problems: error.problems.filter(isWorkspaceProblem) };
    }
    return UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

/** Makes one of the person's workspaces their session's active one. */
export async function switchWorkspace(
  workspaceId: string,
  client: Api = api,
): Promise<SwitchWorkspaceAnswer> {
  try {
    const { data, error, response } = await client.PUT('/api/me/workspace', {
      body: { workspaceId },
    });
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 200 && data) return { kind: 'switched', workspace: data };
    if (response.status === 404 && error?.error === 'workspace_not_found') {
      return { kind: 'not-found' };
    }
    return UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}
