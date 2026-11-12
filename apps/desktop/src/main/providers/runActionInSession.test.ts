import { describe, expect, it, vi } from 'vitest';
import type { InboxItem, WorkItemRef } from '../../shared/workItems';
import type { WorkItemAction } from '../../shared/workItemActions';
import type { Session, Workspace } from '../../shared/workspace';
import { createRunInSessionCoalescer, runActionInSession, type RunActionInSessionDeps } from './runActionInSession';
import { createStubDriver } from './stubDriver.test-helpers';

const pr51: WorkItemRef = { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 };

const item51 = { workItem: pr51, title: 'Extract billing client', url: 'https://github.com/sprocket/catalog-portal/pull/51' } as InboxItem;

const review: WorkItemAction = {
  id: 'a-review',
  name: 'Review',
  appliesTo: ['pr'],
  prompt: 'Review {{type}} #{{number}} ("{{title}}").',
};
const reReview: WorkItemAction = {
  id: 'a-rereview',
  name: 'Re-review',
  appliesTo: ['pr'],
  prompt: 'Pull the latest and check #{{number}} again.',
  conversation: 'fresh',
};
const triage: WorkItemAction = { id: 'a-triage', name: 'Triage', appliesTo: ['issue'], prompt: 'Triage it.' };
const blank: WorkItemAction = { id: 'a-blank', name: 'Blank', appliesTo: ['pr'], prompt: '  ', conversation: 'fresh' };

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'Extract billing client',
    workspaceId: 'ws-1',
    instanceId: 'instance-1',
    claudeSessionId: '11111111-1111-4111-8111-111111111111',
    hasStarted: true,
    harnessId: 'default',
    scopeId: 'scope-1',
    kind: 'interactive',
    workItem: pr51,
    workItemAction: 'Review',
    createdAt: 1,
    lastActiveAt: 1,
    ...overrides,
  } as Session;
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Sprocket',
    defaultHarnessId: 'default',
    scopes: [{ id: 'scope-1', name: 'catalog-portal', path: '/repos/catalog-portal', isGitRepo: true, createdAt: 1 }],
    groups: [],
    provider: { id: 'github', accountLogin: 'octocat' },
    actions: [review, reReview, triage, blank],
    sectionDefaults: {},
    sessions: [makeSession()],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Workspace;
}

function makeDeps(workspace: Workspace, overrides: Partial<RunActionInSessionDeps> = {}) {
  const deps = {
    getWorkspace: (id: string) => (id === workspace.id ? workspace : undefined),
    resolveDriver: vi.fn(() => createStubDriver()),
    findItem: vi.fn(() => item51),
    runInSession: vi.fn(async () => undefined),
    ...overrides,
  } satisfies RunActionInSessionDeps;
  return deps;
}

describe('runActionInSession', () => {
  it('continues the conversation with the rendered body alone, no header', async () => {
    const deps = makeDeps(makeWorkspace());
    const result = await runActionInSession(deps, 'ws-1', 'session-1', 'a-review');
    expect(result).toEqual({ ok: true });
    expect(deps.runInSession).toHaveBeenCalledWith(
      'ws-1',
      'session-1',
      'Review pull request #51 ("Extract billing client").',
      'continue'
    );
  });

  it('starts a fresh conversation with the provider header first, as a new session gets', async () => {
    const deps = makeDeps(makeWorkspace());
    await runActionInSession(deps, 'ws-1', 'session-1', 'a-rereview');
    expect(deps.runInSession).toHaveBeenCalledWith(
      'ws-1',
      'session-1',
      'stub header for #51 (Extract billing client)\n\nPull the latest and check #51 again.',
      'fresh'
    );
  });

  it('renders from the session’s own linked item, without an inbox entry too', async () => {
    const deps = makeDeps(makeWorkspace(), { findItem: vi.fn(() => undefined) });
    await runActionInSession(deps, 'ws-1', 'session-1', 'a-review');
    expect(deps.findItem).toHaveBeenCalledWith('ws-1', pr51);
    expect(vi.mocked(deps.runInSession).mock.calls[0][2]).toBe('Review pull request #51 ("PR #51").');
  });

  it('refuses before delivering anything', async () => {
    const cases: Array<[Workspace, string, string, RegExp]> = [
      [makeWorkspace(), 'session-1', 'a-missing', /Unknown action/],
      [makeWorkspace(), 'session-gone', 'a-review', /no longer exists/],
      [makeWorkspace(), 'session-1', 'a-triage', /does not apply to pull requests/],
      [makeWorkspace(), 'session-1', 'a-blank', /no prompt/],
      [makeWorkspace({ sessions: [makeSession({ workItem: undefined })] }), 'session-1', 'a-review', /not linked/],
      [makeWorkspace({ provider: undefined }), 'session-1', 'a-review', /no provider/],
    ];
    for (const [workspace, sessionId, actionId, message] of cases) {
      const deps = makeDeps(workspace);
      const result = await runActionInSession(deps, 'ws-1', sessionId, actionId);
      expect(result).toEqual({ ok: false, message: expect.stringMatching(message) });
      expect(deps.runInSession).not.toHaveBeenCalled();
    }
  });

  it('returns a delivery failure as a message rather than rejecting', async () => {
    const deps = makeDeps(makeWorkspace(), {
      runInSession: vi.fn(async () => {
        throw new Error('An automation is still running its turn in this session. Wait for it to finish.');
      }),
    });
    const result = await runActionInSession(deps, 'ws-1', 'session-1', 'a-rereview');
    expect(result).toEqual({
      ok: false,
      message: 'An automation is still running its turn in this session. Wait for it to finish.',
    });
  });

  it('coalesces a repeat of the same action on the same session while it is in flight', async () => {
    let release!: () => void;
    const runInSession = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const run = createRunInSessionCoalescer(makeDeps(makeWorkspace(), { runInSession }));

    const first = run('ws-1', 'session-1', 'a-rereview');
    const second = run('ws-1', 'session-1', 'a-rereview');
    // Let the first call reach delivery before releasing it.
    await vi.waitFor(() => expect(runInSession).toHaveBeenCalledTimes(1));
    release();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(runInSession).toHaveBeenCalledTimes(1);

    // Once settled, the same action runs again.
    const third = run('ws-1', 'session-1', 'a-rereview');
    await vi.waitFor(() => expect(runInSession).toHaveBeenCalledTimes(2));
    release();
    await third;
  });
});
