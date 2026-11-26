import createClient from 'openapi-fetch';
import type { Client } from 'openapi-fetch';
import type { paths } from '../domain/apiContract';
import type {
  ConnectAnswer,
  Connections,
  ConnectionsState,
  DisconnectAnswer,
} from '../domain/connections';
import type { MeState } from '../domain/me';
import type { SetIconAnswer, WorkspaceIcon } from '../domain/workspaceIcons';
import { isWorkspaceProblem } from '../domain/workspace';
import type {
  CreateWorkspaceAnswer,
  NewWorkspace,
  SwitchWorkspaceAnswer,
  WorkspacesState,
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

/**
 * Sets the icon of the session's active workspace, or takes it off (null). Only an owner or an
 * admin may; anyone else is `not-allowed`, whatever the page showed them.
 */
export async function setWorkspaceIcon(
  icon: WorkspaceIcon | null,
  client: Api = api,
): Promise<SetIconAnswer> {
  try {
    const { data, error, response } = await client.PUT('/api/me/workspace/icon', {
      body: { icon },
    });
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 200 && data) return { kind: 'changed', workspace: data };
    if (response.status === 403 && error?.error === 'not_allowed') return { kind: 'not-allowed' };
    return UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

/*
 * Connections (14.1): what the workspace is connected to, and connecting or disconnecting
 * GitHub. Kept together at the end of the file.
 */

/** What the session's active workspace is connected to. */
export async function loadConnections(client: Api = api): Promise<ConnectionsState> {
  try {
    const { data, error, response } = await client.GET('/api/connections');
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 409 && error?.error === 'no_active_workspace') {
      return { kind: 'no-workspace' };
    }
    if (response.status !== 200 || !isConnections(data)) return UNAVAILABLE;
    return { kind: 'loaded', connections: data };
  } catch {
    return UNAVAILABLE;
  }
}

/** Whether a body has the shape `GET /api/connections` answers, as far as the page reads it. */
function isConnections(body: unknown): body is Connections {
  if (typeof body !== 'object' || body === null) return false;
  const { canManage, github } = body as { canManage?: unknown; github?: unknown };
  if (typeof canManage !== 'boolean' || typeof github !== 'object' || github === null) return false;
  const { configured, installations } = github as { configured?: unknown; installations?: unknown };
  return typeof configured === 'boolean' && Array.isArray(installations);
}

/** Starts connecting GitHub: the address on GitHub to send the person to. */
export async function startGitHubConnect(client: Api = api): Promise<ConnectAnswer> {
  try {
    const { data, error, response } = await client.POST('/api/connections/github/install');
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 403 && error?.error === 'not_allowed') return { kind: 'not-allowed' };
    if (response.status === 503 && error?.error === 'github_not_configured') {
      return { kind: 'not-configured' };
    }
    const url = data?.url;
    if (response.status !== 200 || typeof url !== 'string' || !isGitHubAddress(url)) {
      return UNAVAILABLE;
    }
    return { kind: 'started', url };
  } catch {
    return UNAVAILABLE;
  }
}

/** Only an address on github.com is somewhere the page sends the person. */
function isGitHubAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

/** Disconnects a GitHub installation from the session's active workspace. */
export async function disconnectGitHub(
  installationId: number,
  client: Api = api,
): Promise<DisconnectAnswer> {
  try {
    const { error, response } = await client.DELETE(
      '/api/connections/github/installations/{installationId}',
      { params: { path: { installationId: String(installationId) } } },
    );
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 204) return { kind: 'disconnected' };
    if (response.status === 404 && error?.error === 'installation_not_found') {
      return { kind: 'not-found' };
    }
    if (response.status === 403 && error?.error === 'not_allowed') return { kind: 'not-allowed' };
    return UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}
