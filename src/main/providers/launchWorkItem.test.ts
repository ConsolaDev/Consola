import { describe, expect, it, vi } from 'vitest';
import type { InboxItem, WorkItemRef } from '../../shared/workItems';
import type { WorkItemAction } from '../../shared/workItemActions';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from './GitProviderDriver';
import { createLaunchCoalescer, launchWorkItem, type WorkItemLaunchDeps } from './launchWorkItem';

const pr51: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };

const item51: InboxItem = {
  workItem: pr51,
  title: 'Extract billing client',
  author: 'steve-sympower',
  roles: ['review-requested-direct'],
  isDraft: false,
  state: 'open',
  reviewDecision: 'review-required',
  ciStatus: 'failing',
  commentCount: 1,
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sympower/controller-app/pull/51',
  additions: 210,
  deletions: 88,
};

const review: WorkItemAction = {
  id: 'a-review',
  name: 'Review',
  appliesTo: ['pr'],
  prompt: 'Review {{type}} #{{number}} ("{{title}}").',
};
const blank: WorkItemAction = { id: 'a-blank', name: 'Blank', appliesTo: ['pr'], prompt: '   ' };

// Only seedHeader matters to a launch; the seam is proven by the launch
// never naming 'github' itself — the driver comes from deps.resolveDriver.
const stubDriver = {
  id: 'github',
  tokenEnvVar: 'STUB_TOKEN',
  seedHeader: (ref: WorkItemRef, item?: InboxItem) =>
    `HEADER ${ref.type} #${ref.number}${item ? ` "${item.title}"` : ''}`,
} as unknown as GitProviderDriver;

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const now = Date.now();
  return {
    id: 'ws-1',
    name: 'Sympower',
    defaultHarnessId: 'default',
    scopes: [
      { id: 'scope-container', name: 'sympower', path: '/repos', isGitRepo: false, createdAt: now },
      { id: 'scope-controller', name: 'controller-app', path: '/repos/controller-app', isGitRepo: true, createdAt: now },
    ],
    groups: [],
    provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
    actions: [review, blank],
    sectionDefaults: {},
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workspace;
}

/** A promise plus its own resolver, for pinning an async mock mid-flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeDeps(workspace: Workspace, overrides: Partial<WorkItemLaunchDeps> = {}) {
  const created: NewSessionFields[] = [];
  const restored: string[] = [];
  let minted = 0;
  const deps: WorkItemLaunchDeps = {
    getWorkspace: (id) => (id === workspace.id ? workspace : undefined),
    resolveDriver: vi.fn(() => stubDriver),
    createSession: (workspaceId, fields) => {
      created.push(fields);
      minted += 1;
      return {
        ...fields,
        id: `session-${minted}`,
        claudeSessionId: `uuid-${minted}`,
        hasStarted: false,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      } as Session;
    },
    resolveRepo: vi.fn(() => '/repos/controller-app'),
    ensureWorktree: vi.fn(async () => '/worktrees/controller-app-pr-51'),
    composeEnv: vi.fn(async () => ({ STUB_TOKEN: 'gho_test' })),
    findItem: () => item51,
    restoreGroup: (_workspaceId, groupId) => {
      restored.push(groupId);
    },
    ...overrides,
  };
  return { deps, created, restored };
}

describe('launchWorkItem', () => {
  it('errors plainly for an unknown workspace', async () => {
    const { deps } = makeDeps(makeWorkspace());
    const result = await launchWorkItem(deps, 'ws-missing', pr51, { id: review.id });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'Unknown workspace: ws-missing' });
  });

  it('errors plainly for a workspace without a provider binding, touching nothing', async () => {
    const { deps, created } = makeDeps(makeWorkspace({ provider: undefined }));
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });
    expect(result).toEqual({
      ok: false,
      reason: 'error',
      message: 'This workspace has no provider account bound.',
    });
    expect(created).toHaveLength(0);
    expect(deps.resolveRepo).not.toHaveBeenCalled();
  });

  it('rejects a malformed ref before anything else', async () => {
    const { deps } = makeDeps(makeWorkspace());
    const bad = { ...pr51, number: 1.5 } as WorkItemRef;
    const result = await launchWorkItem(deps, 'ws-1', bad, { id: review.id });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'Invalid work item reference.' });
    expect(deps.resolveRepo).not.toHaveBeenCalled();
  });

  it('refuses an unknown action id without resolving the repo', async () => {
    const { deps, created } = makeDeps(makeWorkspace());
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: 'a-deleted' });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'Unknown action.' });
    expect(created).toHaveLength(0);
    expect(deps.resolveRepo).not.toHaveBeenCalled();
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });

  it('refuses an empty rendered body before touching disk', async () => {
    const { deps, created } = makeDeps(makeWorkspace());
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: blank.id });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'This action has no prompt to send.' });
    expect(created).toHaveLength(0);
    expect(deps.resolveRepo).not.toHaveBeenCalled();
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });

  it('reports not-cloned when no scope resolves the repo, creating nothing', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), { resolveRepo: vi.fn(() => null) });
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });
    expect(result).toEqual({ ok: false, reason: 'not-cloned' });
    expect(created).toHaveLength(0);
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });

  it('creates no session record when the worktree step fails — atomicity', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), {
      ensureWorktree: vi.fn(async () => {
        throw new Error('fatal: not a valid ref');
      }),
    });
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'fatal: not a valid ref' });
    expect(created).toHaveLength(0);
  });

  // Finding 3: createSession runs inside the same try as resolveRepo and
  // ensureWorktree, so a throw there degrades exactly like a worktree
  // failure instead of rejecting the invoke with Electron's own prefix.
  it('degrades plainly when createSession throws, calling nothing past it', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), {
      createSession: vi.fn(() => {
        throw new Error('disk full');
      }),
    });
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'disk full' });
    expect(created).toHaveLength(0);
    expect(deps.ensureWorktree).toHaveBeenCalledTimes(1);
  });

  it('errors, creating nothing, when the provider is unknown to this build', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), {
      resolveDriver: vi.fn(() => {
        throw new Error('Unknown git provider "gitlab".');
      }),
    });
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'Unknown git provider "gitlab".' });
    expect(created).toHaveLength(0);
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });

  it('creates the record with the matched scope, worktree cwd, item and action name, and returns the seed', async () => {
    const workspace = makeWorkspace();
    const { deps, created } = makeDeps(workspace);

    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seedPrompt).toBe(
      'HEADER pr #51 "Extract billing client"\n\nReview pull request #51 ("Extract billing client").'
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: 'Extract billing client',
      workspaceId: 'ws-1',
      harnessId: 'default',
      scopeId: 'scope-controller', // deepest matching scope, not the container
      cwd: '/worktrees/controller-app-pr-51',
      kind: 'interactive',
      workItem: pr51,
      workItemAction: 'Review',
    });
    expect(created[0].instanceId).toMatch(/^workspace-ws-1-session-/);
    expect(deps.resolveDriver).toHaveBeenCalledWith('github');
    expect(deps.composeEnv).toHaveBeenCalledWith(stubDriver, 'SymJavi');
    expect(deps.ensureWorktree).toHaveBeenCalledWith('/repos/controller-app', pr51, {
      STUB_TOKEN: 'gho_test',
    });
  });

  it('renders a custom prompt like an action and snapshots the name "Custom prompt"', async () => {
    const { deps, created } = makeDeps(makeWorkspace({ actions: [] }));

    const result = await launchWorkItem(deps, 'ws-1', pr51, {
      customPrompt: '  /security-review on {{repo}}  ',
    });

    expect(result).toMatchObject({
      ok: true,
      seedPrompt: 'HEADER pr #51 "Extract billing client"\n\n/security-review on sympower/controller-app',
    });
    expect(created[0]).toMatchObject({ workItemAction: 'Custom prompt' });
  });

  it('refuses a whitespace-only custom prompt', async () => {
    const { deps, created } = makeDeps(makeWorkspace());
    const result = await launchWorkItem(deps, 'ws-1', pr51, { customPrompt: ' \n ' });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'This action has no prompt to send.' });
    expect(created).toHaveLength(0);
  });

  it('falls back to the plain label as the name when the inbox has no item', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), { findItem: () => undefined });
    const issue87: WorkItemRef = { ...pr51, type: 'issue', number: 87 };
    const implement: WorkItemAction = { id: 'a-impl', name: 'Implement', appliesTo: ['issue'], prompt: 'Go.' };
    const workspace = makeWorkspace({ actions: [implement] });
    const { deps: deps2, created: created2 } = makeDeps(workspace, { findItem: () => undefined });

    await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });
    const result = await launchWorkItem(deps2, 'ws-1', issue87, { id: implement.id });

    expect(created[0].name).toBe('PR #51');
    expect(created2[0].name).toBe('Issue #87');
    expect(result).toMatchObject({ ok: true, seedPrompt: 'HEADER issue #87\n\nGo.' });
  });

  // Ruling 4: two direct calls through deps (not the coalescer) for the same
  // ref. Both must succeed with distinct session ids: re-attach is gone, so
  // a second launch of the same item is not folded into the first. The
  // worktree is ensured on each call — it is idempotent, so both sessions
  // land on the identical cwd, and ensureWorktree is asserted to have run
  // twice (once per direct call — nothing here coalesces them).
  it('always mints a new session — two direct launches of the same item never re-attach', async () => {
    const { deps, created } = makeDeps(makeWorkspace());

    const first = await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });
    const second = await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.session.id).not.toBe(first.session.id);
    expect(created).toHaveLength(2);
    expect(created[0].cwd).toBe(created[1].cwd);
    expect(deps.ensureWorktree).toHaveBeenCalledTimes(2);
  });

  // Finding 1: two different actions on the same item run concurrently
  // (that's the point of the action-keyed coalescer above launchWorkItem),
  // but WorktreeService.ensureWorktree is not safe under two overlapping
  // calls for one directory, so launchWorkItem must serialise just that
  // step per item. ensureWorktree is backed by deferred promises so the
  // test can observe the second call has not started until the first
  // settles, without a real timing race.
  it('serialises the worktree step per item while different actions still run concurrently', async () => {
    const fixCi: WorkItemAction = { id: 'a-fixci', name: 'Fix CI', appliesTo: ['pr'], prompt: 'Fix.' };
    const workspace = makeWorkspace({ actions: [review, fixCi] });
    const firstCall = deferred<string>();
    const secondCall = deferred<string>();
    let ensureWorktreeCalls = 0;
    const ensureWorktree = vi.fn(async () => {
      ensureWorktreeCalls += 1;
      return ensureWorktreeCalls === 1 ? firstCall.promise : secondCall.promise;
    });
    const { deps, created } = makeDeps(workspace, { ensureWorktree });

    const launch1 = launchWorkItem(deps, 'ws-1', pr51, { id: review.id });
    const launch2 = launchWorkItem(deps, 'ws-1', pr51, { id: fixCi.id });

    // Flush microtasks generously so both launches reach the worktree step.
    // launch2's ensureWorktree call cannot start no matter how many ticks
    // pass here: it is chained after launch1's, which is itself blocked on
    // an unresolved deferred promise.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(ensureWorktree).toHaveBeenCalledTimes(1);

    firstCall.resolve('/worktrees/controller-app-pr-51');
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(ensureWorktree).toHaveBeenCalledTimes(2);
    secondCall.resolve('/worktrees/controller-app-pr-51');

    const [result1, result2] = await Promise.all([launch1, launch2]);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (!result1.ok || !result2.ok) return;
    expect(result2.session.id).not.toBe(result1.session.id);
    expect(created[0].cwd).toBe(created[1].cwd);
  });
});

describe('launchWorkItem — the group an action lands in', () => {
  const reviews = { id: 'g-reviews', name: 'PR reviews', createdAt: 1 };
  const routed = { ...review, groupId: reviews.id };

  it('lands the session in the action\'s group', async () => {
    const { deps, created, restored } = makeDeps(
      makeWorkspace({ actions: [routed], groups: [reviews] })
    );
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: routed.id });
    expect(result.ok).toBe(true);
    expect(created[0].groupId).toBe('g-reviews');
    expect(restored).toEqual([]);
  });

  it('leaves an unrouted action landing under its scope, with no groupId key at all', async () => {
    const { deps, created } = makeDeps(makeWorkspace({ groups: [reviews] }));
    await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });
    expect(created[0]).not.toHaveProperty('groupId');
  });

  it('restores an archived target so the arrival is visible under its heading', async () => {
    const archived = { ...reviews, archivedAt: 1_700_000_000_000 };
    const { deps, created, restored } = makeDeps(
      makeWorkspace({ actions: [routed], groups: [archived] })
    );
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: routed.id });
    expect(result.ok).toBe(true);
    expect(restored).toEqual(['g-reviews']);
    expect(created[0].groupId).toBe('g-reviews');
  });

  it('still launches, ungrouped, when the target group is gone', async () => {
    const { deps, created, restored } = makeDeps(makeWorkspace({ actions: [routed], groups: [] }));
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: routed.id });
    expect(result.ok).toBe(true);
    expect(created[0]).not.toHaveProperty('groupId');
    expect(restored).toEqual([]);
  });

  it('never restores a group when the launch fails before the record is made', async () => {
    const archived = { ...reviews, archivedAt: 1_700_000_000_000 };
    const { deps, created, restored } = makeDeps(
      makeWorkspace({ actions: [routed], groups: [archived] }),
      {
        ensureWorktree: vi.fn(async () => {
          throw new Error('git said no');
        }),
      }
    );
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: routed.id });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'git said no' });
    expect(created).toHaveLength(0);
    expect(restored).toEqual([]);
  });

  it('lands a custom prompt ungrouped — it is nobody\'s configured verb', async () => {
    const { deps, created } = makeDeps(makeWorkspace({ actions: [routed], groups: [reviews] }));
    const result = await launchWorkItem(deps, 'ws-1', pr51, { customPrompt: 'Just look at it.' });
    expect(result.ok).toBe(true);
    expect(created[0].workItemAction).toBe('Custom prompt');
    expect(created[0]).not.toHaveProperty('groupId');
  });
});

describe('createLaunchCoalescer', () => {
  it('coalesces concurrent launches of the same item and action into one call', async () => {
    const { deps, created } = makeDeps(makeWorkspace());
    const launch = createLaunchCoalescer(deps);

    const [first, second] = await Promise.all([
      launch('ws-1', pr51, { id: review.id }),
      launch('ws-1', pr51, { id: review.id }),
    ]);

    expect(created).toHaveLength(1);
    expect(deps.ensureWorktree).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('does not coalesce two different actions on the same item', async () => {
    const fixCi: WorkItemAction = { id: 'a-fixci', name: 'Fix CI', appliesTo: ['pr'], prompt: 'Fix.' };
    const { deps, created } = makeDeps(makeWorkspace({ actions: [review, fixCi] }));
    const launch = createLaunchCoalescer(deps);

    await Promise.all([launch('ws-1', pr51, { id: review.id }), launch('ws-1', pr51, { id: fixCi.id })]);

    expect(created).toHaveLength(2);
    expect(created.map((fields) => fields.workItemAction).sort()).toEqual(['Fix CI', 'Review']);
  });

  it('coalesces a custom prompt by its trimmed body', async () => {
    const { deps, created } = makeDeps(makeWorkspace());
    const launch = createLaunchCoalescer(deps);

    await Promise.all([
      launch('ws-1', pr51, { customPrompt: '/security-review' }),
      launch('ws-1', pr51, { customPrompt: '  /security-review\n' }),
    ]);

    expect(created).toHaveLength(1);
  });

  it('does not coalesce launches of different work items', async () => {
    const issue87: WorkItemRef = { ...pr51, type: 'issue', number: 87 };
    const implement: WorkItemAction = { id: 'a-impl', name: 'Implement', appliesTo: ['issue'], prompt: 'Go.' };
    const { deps, created } = makeDeps(makeWorkspace({ actions: [review, implement] }));
    const launch = createLaunchCoalescer(deps);

    await Promise.all([launch('ws-1', pr51, { id: review.id }), launch('ws-1', issue87, { id: implement.id })]);

    expect(created).toHaveLength(2);
  });

  it('runs a later launch of the same item and action fresh once the first has settled', async () => {
    const workspace = makeWorkspace();
    const { deps, created } = makeDeps(workspace);
    const launch = createLaunchCoalescer(deps);

    const first = await launch('ws-1', pr51, { id: review.id });
    if (!first.ok) throw new Error('expected the first launch to succeed');
    workspace.sessions = [first.session];
    const second = await launch('ws-1', pr51, { id: review.id });

    // Two clicks, spaced out, are two sessions: always-a-new-session.
    expect(created).toHaveLength(2);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.session.id).not.toBe(first.session.id);
  });
});
