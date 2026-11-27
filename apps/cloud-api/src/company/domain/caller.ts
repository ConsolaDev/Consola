import type { WorkspaceRole } from '../../shared/workspaceRole.js';

declare const admitted: unique symbol;

/** What only `admitCaller` gives a caller. It exists for the type checker alone. */
type CallerBrand = { readonly [admitted]: true };

/**
 * Who is asking, on a company route: the person their session names, the session itself, the
 * workspace the session has active, and their role there as `member` holds it at this request.
 * A person and a session are their ids and no more: company code never reads an account.
 *
 * Only `admitCaller` makes one (the brand), so a use case that takes a `Caller` gets the person
 * and the workspace from the session, never from the request.
 */
export type Caller = {
  /** The person's id, the one accounts gives them. */
  readonly personId: string;
  /** The id of the session that asked: what binds a GitHub Connect to the browser it began in. */
  readonly sessionId: string;
  /** The workspace the session has active, which the page showed too. */
  readonly workspaceId: string;
  /** The person's role in that workspace, read for this request. */
  readonly role: WorkspaceRole;
} & CallerBrand;

/**
 * A signed-in person as their session says: who they are, which session it is, and which
 * workspace it has active.
 */
export type SignedInPerson = {
  personId: string;
  sessionId: string;
  activeWorkspaceId: string | null;
};

/** Why a request is not let onto a company route, with the status it is answered with. */
export type CallerRefusal =
  /** No session. */
  | { status: 401; error: 'signed_out' }
  /** No `x-consola-workspace`: the request does not say which workspace its page shows. */
  | { status: 400; error: 'invalid_request' }
  /** The session has no workspace active. */
  | { status: 409; error: 'no_active_workspace' }
  /** The page shows another workspace than the session has active: another tab switched it. */
  | { status: 409; error: 'workspace_switched' }
  /** The person is not a member of the active workspace, or no longer. */
  | { status: 403; error: 'not_a_member' };

/**
 * The rule for letting a request onto a company route, checked in this order: signed out, no
 * workspace shown, no active workspace, a shown workspace that is not the active one, and no
 * role. `role` is the person's role in the session's active workspace (null when `member` holds
 * none), never in the one shown. The shown workspace is only a guard: the caller's workspace is
 * the session's.
 */
export function admitCaller(asking: {
  signedIn: SignedInPerson | null;
  shownWorkspaceId: string | null;
  role: WorkspaceRole | null;
}): { ok: true; caller: Caller } | ({ ok: false } & CallerRefusal) {
  const { signedIn, shownWorkspaceId, role } = asking;
  if (signedIn === null) return { ok: false, status: 401, error: 'signed_out' };
  if (shownWorkspaceId === null) return { ok: false, status: 400, error: 'invalid_request' };
  const active = signedIn.activeWorkspaceId;
  if (active === null) return { ok: false, status: 409, error: 'no_active_workspace' };
  if (shownWorkspaceId !== active) return { ok: false, status: 409, error: 'workspace_switched' };
  if (role === null) return { ok: false, status: 403, error: 'not_a_member' };
  const caller = {
    personId: signedIn.personId,
    sessionId: signedIn.sessionId,
    workspaceId: active,
    role,
  } as Caller;
  return { ok: true, caller };
}
