import createClient from 'openapi-fetch';
import type { Client } from 'openapi-fetch';
import type { paths } from '../domain/apiContract';
import type {
  ChoiceState,
  ChooseAnswer,
  ConnectAnswer,
  Connections,
  ConnectionsState,
  DisconnectAnswer,
  GitHubCandidate,
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

/** A client of the API, typed by its contract: every path, body and answer. */
export type Api = Client<paths>;

/** What the client sends its requests with: the browser's `fetch`, unless a test passes its own. */
export type Send = (request: Request) => Promise<Response>;

/**
 * The header that names the workspace the page shows, on every call about what a workspace
 * holds. The API reads the workspace from the session, never from this: it is a guard, so a page
 * another tab has switched away from never reads or changes the session's new workspace under
 * the old one's name (409 `workspace_switched`).
 */
export const WORKSPACE_HEADER = 'x-consola-workspace';

/** Where a client sends from: a test passes its own `fetch` and an absolute `baseUrl`. */
export type ApiOptions = { fetch?: Send; baseUrl?: string };

/**
 * The API's client, and the only way a service reaches the API: no service calls `fetch` itself
 * (`boundary.test.ts`). The page and the API share one origin, through the dev server's /api
 * proxy, so its paths are relative. A test passes its own `fetch` and an absolute `baseUrl`,
 * since Node has no page to resolve a relative address against. Given `workspaceId`, every
 * request names that workspace (`WORKSPACE_HEADER`).
 */
export function createApi(options: ApiOptions & { workspaceId?: string } = {}): Api {
  const client = createClient<paths>({
    baseUrl: options.baseUrl ?? '',
    fetch: options.fetch,
    credentials: 'same-origin',
  });
  const { workspaceId } = options;
  if (workspaceId !== undefined) {
    client.use({
      onRequest({ request }) {
        request.headers.set(WORKSPACE_HEADER, workspaceId);
        return request;
      },
    });
  }
  return client;
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
    const { name, slug } = workspace;
    const { data, error, response } = await client.POST('/api/workspaces', {
      body: { name, slug },
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
 * GitHub. Kept together at the end of the file. They are the workspace's, so every call names
 * the workspace the page shows (`WORKSPACE_HEADER`), and the API refuses one the session no
 * longer has open.
 */

/** What `workspace`, the session's active one, is connected to. */
export async function loadConnections(
  workspace: { id: string },
  options: ApiOptions = {},
): Promise<ConnectionsState> {
  try {
    const client = createApi({ ...options, workspaceId: workspace.id });
    const { data, error, response } = await client.GET('/api/connections');
    if (response.status === 401) return { kind: 'signed-out' };
    const code = error?.error;
    if (
      (response.status === 409 &&
        (code === 'no_active_workspace' || code === 'workspace_switched')) ||
      (response.status === 403 && code === 'not_a_member')
    ) {
      return { kind: 'switched' };
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

/**
 * Starts connecting GitHub to `workspace`: the addresses on GitHub to send the person to, its
 * sign-in for the app first, and its install page for another account. A workspace the session
 * no longer has open is `unavailable`, as the page cannot act for it.
 */
export async function startGitHubConnect(
  workspace: { id: string },
  options: ApiOptions = {},
): Promise<ConnectAnswer> {
  try {
    const client = createApi({ ...options, workspaceId: workspace.id });
    const { data, error, response } = await client.POST('/api/connections/github/install');
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 403 && error?.error === 'not_allowed') return { kind: 'not-allowed' };
    if (response.status === 503 && error?.error === 'github_not_configured') {
      return { kind: 'not-configured' };
    }
    const url = data?.url;
    const installUrl = data?.installUrl;
    if (
      response.status !== 200 ||
      typeof url !== 'string' ||
      typeof installUrl !== 'string' ||
      !isGitHubAddress(url) ||
      !isGitHubAddress(installUrl)
    ) {
      return UNAVAILABLE;
    }
    return { kind: 'started', url, installUrl };
  } catch {
    return UNAVAILABLE;
  }
}

/** A choice the API refused, for the reason it named. */
const refused = <Reason extends string>(reason: Reason) => ({ kind: 'refused', reason }) as const;

/**
 * The installations a signed choice offers (`choice`, as the API's callback sent the page back
 * with it), read for `workspace`, the session's active one. The API reads it only for the session
 * that signed in, in time, for that workspace, and for an owner or admin; each refusal is named.
 */
export async function loadGitHubChoice(
  workspace: { id: string },
  choice: string,
  options: ApiOptions = {},
): Promise<ChoiceState> {
  try {
    const client = createApi({ ...options, workspaceId: workspace.id });
    const { data, error, response } = await client.GET('/api/connections/github/choice', {
      params: { query: { choice } },
    });
    if (response.status === 401) return { kind: 'signed-out' };
    const code = error?.error;
    if (response.status === 400 && code === 'bad_choice') return refused('bad-choice');
    if (response.status === 403 && code === 'not_allowed') return refused('not-allowed');
    if (response.status === 409 && code === 'choice_for_another_workspace') {
      return refused('other-workspace');
    }
    if (response.status === 410 && code === 'choice_expired') return refused('expired');
    if (
      (response.status === 409 &&
        (code === 'no_active_workspace' || code === 'workspace_switched')) ||
      (response.status === 403 && code === 'not_a_member')
    ) {
      return { kind: 'switched' };
    }
    const candidates = data?.candidates;
    if (response.status !== 200 || !Array.isArray(candidates) || !candidates.every(isCandidate)) {
      return UNAVAILABLE;
    }
    return { kind: 'loaded', candidates };
  } catch {
    return UNAVAILABLE;
  }
}

/** Whether an entry has the shape of a candidate, as far as the page reads it. */
function isCandidate(entry: unknown): entry is GitHubCandidate {
  if (typeof entry !== 'object' || entry === null) return false;
  const { id, account } = entry as { id?: unknown; account?: unknown };
  if (typeof id !== 'number' || typeof account !== 'object' || account === null) return false;
  const { login, type } = account as { login?: unknown; type?: unknown };
  const { heldElsewhere } = entry as { heldElsewhere?: unknown };
  return (
    typeof login === 'string' &&
    (type === 'Organization' || type === 'User') &&
    typeof heldElsewhere === 'boolean'
  );
}

/**
 * Connects the installation the person chose (`installationId`) of a signed choice to
 * `workspace`, the session's active one. The API checks everything again; a workspace the session
 * no longer has open is `unavailable`, as for any change the page cannot vouch for.
 */
export async function connectChosenGitHub(
  workspace: { id: string },
  chosen: { choice: string; installationId: number },
  options: ApiOptions = {},
): Promise<ChooseAnswer> {
  try {
    const client = createApi({ ...options, workspaceId: workspace.id });
    const { data, error, response } = await client.POST('/api/connections/github/choice', {
      body: { choice: chosen.choice, installationId: chosen.installationId },
    });
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 200 && data?.result === 'connected') return { kind: 'connected' };
    if (response.status === 200 && data?.result === 'already_connected') {
      return { kind: 'already-connected' };
    }
    const code = error?.error;
    if (response.status === 400 && code === 'bad_choice') return refused('bad-choice');
    if (response.status === 400 && code === 'not_a_candidate') return refused('not-a-candidate');
    if (response.status === 403 && code === 'not_allowed') return refused('not-allowed');
    if (response.status === 409 && code === 'choice_for_another_workspace') {
      return refused('other-workspace');
    }
    if (response.status === 409 && code === 'installation_taken') return refused('taken');
    if (response.status === 410 && code === 'choice_expired') return refused('expired');
    return UNAVAILABLE;
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

/** Disconnects a GitHub installation from `workspace`, the session's active one. */
export async function disconnectGitHub(
  workspace: { id: string },
  installationId: number,
  options: ApiOptions = {},
): Promise<DisconnectAnswer> {
  try {
    const client = createApi({ ...options, workspaceId: workspace.id });
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
