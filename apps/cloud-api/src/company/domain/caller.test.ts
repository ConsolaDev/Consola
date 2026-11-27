import { describe, expect, it } from 'vitest';
import { WORKSPACE_ROLES } from '../../shared/workspaceRole.js';
import { admitCaller } from './caller.js';
import type { Caller, SignedInPerson } from './caller.js';

const signedIn = (activeWorkspaceId: string | null = 'acme'): SignedInPerson => ({
  personId: 'person-1',
  sessionId: 'session-1',
  activeWorkspaceId,
});

/** A request that gets in: signed in, showing the active workspace, and a member of it. */
const asking = (overrides: Partial<Parameters<typeof admitCaller>[0]> = {}) => ({
  signedIn: signedIn(),
  shownWorkspaceId: 'acme',
  role: 'admin' as const,
  ...overrides,
});

describe('admitCaller', () => {
  it('admits a member asking about the workspace their session has active', () => {
    expect(admitCaller(asking())).toEqual({
      ok: true,
      caller: { personId: 'person-1', sessionId: 'session-1', workspaceId: 'acme', role: 'admin' },
    });
  });

  it('gives the caller the role it is handed, whichever it is', () => {
    for (const role of WORKSPACE_ROLES) {
      const admission = admitCaller(asking({ role }));
      expect(admission.ok && admission.caller.role).toBe(role);
    }
  });

  it('refuses a request with no session as signed out', () => {
    expect(admitCaller(asking({ signedIn: null }))).toEqual({
      ok: false,
      status: 401,
      error: 'signed_out',
    });
  });

  it('refuses a request that does not say which workspace its page shows', () => {
    expect(admitCaller(asking({ shownWorkspaceId: null }))).toEqual({
      ok: false,
      status: 400,
      error: 'invalid_request',
    });
  });

  it('refuses a session with no active workspace', () => {
    expect(admitCaller(asking({ signedIn: signedIn(null) }))).toEqual({
      ok: false,
      status: 409,
      error: 'no_active_workspace',
    });
  });

  it('refuses a page showing another workspace than the session has active', () => {
    // Another tab switched the session's workspace: the page's is not the one acted on.
    expect(admitCaller(asking({ shownWorkspaceId: 'sprocket' }))).toEqual({
      ok: false,
      status: 409,
      error: 'workspace_switched',
    });
  });

  it('refuses someone who is not a member of the active workspace', () => {
    expect(admitCaller(asking({ role: null }))).toEqual({
      ok: false,
      status: 403,
      error: 'not_a_member',
    });
  });

  it('checks in order: signed out, no header, no active workspace, switched, not a member', () => {
    const cases: Array<[Parameters<typeof admitCaller>[0], string]> = [
      [asking({ signedIn: null, shownWorkspaceId: null }), 'signed_out'],
      [asking({ signedIn: null, role: null }), 'signed_out'],
      [asking({ shownWorkspaceId: null, signedIn: signedIn(null) }), 'invalid_request'],
      [asking({ shownWorkspaceId: null, role: null }), 'invalid_request'],
      [asking({ signedIn: signedIn(null), shownWorkspaceId: 'sprocket' }), 'no_active_workspace'],
      [asking({ signedIn: signedIn(null), role: null }), 'no_active_workspace'],
      [asking({ shownWorkspaceId: 'sprocket', role: null }), 'workspace_switched'],
    ];
    for (const [request, error] of cases) {
      const admission = admitCaller(request);
      expect(admission.ok ? 'admitted' : admission.error).toBe(error);
    }
  });

  it('takes the workspace from the session, never from the header alone', () => {
    const admission = admitCaller(asking({ signedIn: signedIn('sprocket') }));
    expect(admission).toEqual({ ok: false, status: 409, error: 'workspace_switched' });
  });

  it('is the only way to a caller: one written by hand does not type-check', () => {
    // @ts-expect-error A caller comes from `admitCaller`, never from a literal.
    const forged: Caller = { personId: 'person-1', workspaceId: 'sprocket', role: 'owner' };
    expect(forged.workspaceId).toBe('sprocket');
  });
});
