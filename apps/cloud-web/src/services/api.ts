import type { Me, MeState } from '../domain/me';
import {
  type CreateWorkspaceAnswer,
  isWorkspaceProblem,
  type MyWorkspace,
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
 */

const UNAVAILABLE = { kind: 'unavailable' } as const;

/** Sends `body` as JSON with the person's cookie. */
function sendJson(fetchFn: typeof fetch, method: 'POST' | 'PUT', path: string, body: unknown) {
  return fetchFn(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The `error` code of an API error body, if it has one. */
function errorCode(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
}

/** Who is signed in, and the workspace their session has active. */
export async function loadMe(fetchFn: typeof fetch = fetch): Promise<MeState> {
  try {
    const response = await fetchFn('/api/me', { credentials: 'same-origin' });
    if (response.status === 401) return { kind: 'signed-out' };
    if (!response.ok) return UNAVAILABLE;
    return { kind: 'signed-in', me: (await response.json()) as Me };
  } catch {
    return UNAVAILABLE;
  }
}

/** The person's workspaces, in the order they joined. */
export async function loadWorkspaces(fetchFn: typeof fetch = fetch): Promise<WorkspacesState> {
  try {
    const response = await fetchFn('/api/workspaces', { credentials: 'same-origin' });
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status !== 200) return UNAVAILABLE;
    const body: unknown = await response.json();
    const workspaces =
      typeof body === 'object' && body !== null && 'workspaces' in body ? body.workspaces : null;
    if (!Array.isArray(workspaces)) return UNAVAILABLE;
    return { kind: 'listed', workspaces: workspaces as MyWorkspace[] };
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
  fetchFn: typeof fetch = fetch,
): Promise<CreateWorkspaceAnswer> {
  try {
    const { name, slug, region } = workspace;
    const response = await sendJson(fetchFn, 'POST', '/api/workspaces', { name, slug, region });
    if (response.status === 401) return { kind: 'signed-out' };
    const body: unknown = await response.json();
    if (response.status === 201) return { kind: 'created', workspace: body as MyWorkspace };
    if (response.status === 409 && errorCode(body) === 'slug_taken') return { kind: 'slug-taken' };
    if (response.status === 400 && errorCode(body) === 'invalid_workspace') {
      const problems = (body as { problems?: unknown }).problems;
      if (Array.isArray(problems)) {
        return { kind: 'invalid', problems: problems.filter(isWorkspaceProblem) };
      }
    }
    return UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

/** Makes one of the person's workspaces their session's active one. */
export async function switchWorkspace(
  workspaceId: string,
  fetchFn: typeof fetch = fetch,
): Promise<SwitchWorkspaceAnswer> {
  try {
    const response = await sendJson(fetchFn, 'PUT', '/api/me/workspace', { workspaceId });
    if (response.status === 401) return { kind: 'signed-out' };
    const body: unknown = await response.json();
    if (response.status === 200) return { kind: 'switched', workspace: body as MyWorkspace };
    if (response.status === 404 && errorCode(body) === 'workspace_not_found') {
      return { kind: 'not-found' };
    }
    return UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}
