import type { Refusal } from '../domain/refusal';
import { createApi } from './api';
import type { Api, ApiOptions } from './api';

/*
 * The way to what a workspace holds (its teams, factories, runs and cloud sessions), which every
 * service of them shares. Each call goes through the API's client with the workspace the page
 * shows in `x-consola-workspace` (`createApi`'s `workspaceId`). The API takes the workspace from
 * the session's cookie, never from the header: the header is a guard, because another tab can
 * switch the session's workspace, and a call for the page's workspace would then read and change
 * the other one under its name. The API refuses such a call before it reads or writes anything.
 *
 * The caller's refusals mean the same on every route, so they are read here, once: only a 401
 * is signed out; a session with no workspace open, with another than the page shows, or one the
 * person is no longer a member of is `switched`. What else an answer says is each service's to
 * read, and anything it does not expect is `unavailable`.
 */

export const UNAVAILABLE = { kind: 'unavailable' } as const;
export const SWITCHED = { kind: 'switched' } as const;
export const SIGNED_OUT = { kind: 'signed-out' } as const;

export type { Refusal };

/** The `error` code of an answer's body, if it has one. */
export function codeOf(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
}

/** The refusal of the caller an answer is, on any route of a workspace's, or null. */
export function callerRefusalOf(answer: { error?: unknown; response: Response }): Refusal | null {
  const { status } = answer.response;
  if (status === 401) return SIGNED_OUT;
  const code = codeOf(answer.error);
  if (status === 409 && (code === 'workspace_switched' || code === 'no_active_workspace')) {
    return SWITCHED;
  }
  if (status === 403 && code === 'not_a_member') return SWITCHED;
  return null;
}

/**
 * Runs `call` against the API for `workspaceId`, the workspace the page shows, answering the
 * call's answer, or the caller's refusal it came to.
 */
export type OnWorkspace = <Answer extends { error?: unknown; response: Response }>(
  workspaceId: string,
  call: (api: Api) => Promise<Answer>,
) => Promise<Answer | Refusal>;

/** A way to the workspace's API: the page's uses the browser's `fetch`, a test its own. */
export function workspaceCalls(options: ApiOptions = {}): OnWorkspace {
  return async (workspaceId, call) => {
    const answer = await call(createApi({ ...options, workspaceId }));
    return callerRefusalOf(answer) ?? answer;
  };
}
