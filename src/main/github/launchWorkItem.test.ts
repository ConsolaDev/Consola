import { describe, expect, it, vi } from 'vitest';
import type { InboxItem, WorkItemRef } from '../../shared/github';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';
import {
  buildSeedPrompt,
  createLaunchCoalescer,
  launchWorkItem,
  workItemSessionName,
  type WorkItemLaunchDeps,
} from './launchWorkItem';

const pr51: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };

const item51: InboxItem = {
  workItem: pr51,
  title: 'Extract billing client',
  state: 'open',
  role: 'review-requested',
  ciStatus: 'failing',
  reviewDecision: 'REVIEW_REQUIRED',
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sympower/controller-app/pull/51',
  additions: 210,
  deletions: 88,
};

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
    github: { accountLogin: 'SymJavi', org: 'sympower' },
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workspace;
}

function makeDeps(workspace: Workspace, overrides: Partial<WorkItemLaunchDeps> = {}) {
  const created: NewSessionFields[] = [];
  const deps: WorkItemLaunchDeps = {
    getWorkspace: (id) => (id === workspace.id ? workspace : undefined),
    createSession: (workspaceId, fields) => {
      created.push(fields);
      return {
        ...fields,
        id: 'session-new',
        claudeSessionId: 'uuid-new',
        hasStarted: false,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      } as Session;
    },
    resolveRepo: () => '/repos/controller-app',
    ensureWorktree: vi.fn(async () => '/worktrees/controller-app-pr-51'),
    composeEnv: async () => ({ GH_TOKEN: 'gho_test' }),
    findItem: () => item51,
    pathExists: () => true,
    ...overrides,
  };
  return { deps, created };
}

describe('launchWorkItem', () => {
  it('re-attaches to an existing session for the same work item, touching nothing', async () => {
    const existing = {
      id: 'session-existing',
      name: 'PR #51 - Extract billing client',
      workspaceId: 'ws-1',
      instanceId: 'inst-existing',
      claudeSessionId: 'uuid-existing',
      hasStarted: true,
      harnessId: 'default',
      scopeId: 'scope-controller',
      cwd: '/worktrees/controller-app-pr-51',
      kind: 'interactive',
      workItem: { ...pr51, repo: 'Sympower/Controller-App' }, // casing differs on purpose
      createdAt: 1,
      lastActiveAt: 1,
    } as unknown as Session;
    const workspace = makeWorkspace({ sessions: [existing] });
    const { deps, created } = makeDeps(workspace);

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: true, session: existing, reattached: true });
    expect(created).toHaveLength(0);
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });

  it('re-ensures a deleted worktree before re-attaching, and reports no fresh session', async () => {
    const existing = {
      id: 'session-existing',
      name: 'PR #51 - Extract billing client',
      workspaceId: 'ws-1',
      instanceId: 'inst-existing',
      claudeSessionId: 'uuid-existing',
      hasStarted: true,
      harnessId: 'default',
      scopeId: 'scope-controller',
      cwd: '/worktrees/controller-app-pr-51',
      kind: 'interactive',
      workItem: pr51,
      createdAt: 1,
      lastActiveAt: 1,
    } as unknown as Session;
    const workspace = makeWorkspace({ sessions: [existing] });
    const { deps, created } = makeDeps(workspace, { pathExists: () => false });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: true, session: existing, reattached: true });
    expect(created).toHaveLength(0);
    expect(deps.ensureWorktree).toHaveBeenCalledWith(
      '/repos/controller-app',
      pr51,
      { GH_TOKEN: 'gho_test' }
    );
  });

  it('re-attaches without ensuring anything when the clone itself is gone too', async () => {
    const existing = {
      id: 'session-existing',
      name: 'PR #51 - Extract billing client',
      workspaceId: 'ws-1',
      instanceId: 'inst-existing',
      claudeSessionId: 'uuid-existing',
      hasStarted: true,
      harnessId: 'default',
      scopeId: 'scope-controller',
      cwd: '/worktrees/controller-app-pr-51',
      kind: 'interactive',
      workItem: pr51,
      createdAt: 1,
      lastActiveAt: 1,
    } as unknown as Session;
    const workspace = makeWorkspace({ sessions: [existing] });
    const { deps } = makeDeps(workspace, { pathExists: () => false, resolveRepo: () => null });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    // The clone can't be resolved, so there's nothing to rebuild the
    // worktree from — the honest answer is today's re-attach, which hands
    // the user the existing terminal's "working folder not found" notice.
    expect(result).toEqual({ ok: true, session: existing, reattached: true });
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });

  it('surfaces ensureWorktree failure as the launch error rather than re-attaching into a broken directory', async () => {
    const existing = {
      id: 'session-existing',
      name: 'PR #51 - Extract billing client',
      workspaceId: 'ws-1',
      instanceId: 'inst-existing',
      claudeSessionId: 'uuid-existing',
      hasStarted: true,
      harnessId: 'default',
      scopeId: 'scope-controller',
      cwd: '/worktrees/controller-app-pr-51',
      kind: 'interactive',
      workItem: pr51,
      createdAt: 1,
      lastActiveAt: 1,
    } as unknown as Session;
    const workspace = makeWorkspace({ sessions: [existing] });
    const { deps } = makeDeps(workspace, {
      pathExists: () => false,
      ensureWorktree: vi.fn(async () => {
        throw new Error('fatal: unable to recreate worktree');
      }),
    });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({
      ok: false,
      reason: 'error',
      message: 'fatal: unable to recreate worktree',
    });
  });

  it('reports not-cloned when no scope resolves the repo, creating nothing', async () => {
    const workspace = makeWorkspace();
    const { deps, created } = makeDeps(workspace, { resolveRepo: () => null });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: false, reason: 'not-cloned' });
    expect(created).toHaveLength(0);
  });

  it('creates no session record when the worktree step fails — atomicity', async () => {
    const workspace = makeWorkspace();
    const { deps, created } = makeDeps(workspace, {
      ensureWorktree: vi.fn(async () => {
        throw new Error('fatal: not a valid ref');
      }),
    });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: false, reason: 'error', message: 'fatal: not a valid ref' });
    expect(created).toHaveLength(0);
  });

  it('creates the record with the matched scope, worktree cwd, and work item', async () => {
    const workspace = makeWorkspace();
    const { deps, created } = makeDeps(workspace);

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reattached).toBe(false);
    expect(result.seedPrompt).toContain('#51');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: 'PR #51 - Extract billing client',
      workspaceId: 'ws-1',
      harnessId: 'default',
      scopeId: 'scope-controller', // deepest matching scope, not the container
      cwd: '/worktrees/controller-app-pr-51',
      kind: 'interactive',
      workItem: pr51,
    });
    expect(created[0].instanceId).toMatch(/^workspace-ws-1-session-/);
  });

  it('errors plainly for a workspace without a github binding', async () => {
    const workspace = makeWorkspace({ github: undefined });
    const { deps } = makeDeps(workspace);

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result.ok).toBe(false);
  });
});

describe('createLaunchCoalescer', () => {
  it('coalesces concurrent launches of the same work item into one call', async () => {
    const workspace = makeWorkspace();
    const { deps, created } = makeDeps(workspace);
    const launch = createLaunchCoalescer(deps);

    // Not reachable through the UI (the renderer's `launching[key]` disables
    // the button), but this proves the main-side defence: two overlapping
    // calls must not each pass the "existing session" check and mint a
    // rival session for the same work item.
    const [first, second] = await Promise.all([launch('ws-1', pr51), launch('ws-1', pr51)]);

    expect(created).toHaveLength(1);
    expect(deps.ensureWorktree).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('does not coalesce launches of different work items', async () => {
    const issue87: WorkItemRef = { ...pr51, type: 'issue', number: 87 };
    const workspace = makeWorkspace();
    const { deps, created } = makeDeps(workspace);
    const launch = createLaunchCoalescer(deps);

    await Promise.all([launch('ws-1', pr51), launch('ws-1', issue87)]);

    expect(created).toHaveLength(2);
  });

  it('runs a later launch of the same item fresh once the first has settled', async () => {
    const workspace = makeWorkspace();
    const { deps, created } = makeDeps(workspace);
    const launch = createLaunchCoalescer(deps);

    const first = await launch('ws-1', pr51);
    if (!first.ok) throw new Error('expected the first launch to succeed');
    // The real session now exists in `workspace.sessions` (as it would once
    // WorkspaceService persists it), so this second, non-overlapping call
    // re-attaches rather than launching fresh.
    workspace.sessions = [first.session];
    const second = await launch('ws-1', pr51);

    expect(created).toHaveLength(1);
    expect(second).toMatchObject({ ok: true, reattached: true });
  });
});

describe('buildSeedPrompt', () => {
  it('describes the item and the worktree, and starts from gh view', () => {
    const prompt = buildSeedPrompt(pr51, item51);
    expect(prompt).toContain('pull request #51');
    expect(prompt).toContain('Extract billing client');
    expect(prompt).toContain('sympower/controller-app');
    expect(prompt).toContain('gh pr view 51');
    expect(prompt).toContain('worktree');
  });

  it('still reads sensibly without a cached inbox item', () => {
    const prompt = buildSeedPrompt({ ...pr51, type: 'issue', number: 87 });
    expect(prompt).toContain('issue #87');
    expect(prompt).toContain('gh issue view 87');
  });
});

describe('workItemSessionName', () => {
  it('uses the title when the inbox holds one, a plain label when not', () => {
    expect(workItemSessionName(pr51, item51)).toBe('PR #51 - Extract billing client');
    expect(workItemSessionName(pr51)).toBe('PR #51');
    expect(workItemSessionName({ ...pr51, type: 'issue', number: 87 })).toBe('Issue #87');
  });
});
