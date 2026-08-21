import { describe, expect, it, vi } from 'vitest';
import type { InboxItem, WorkItemRef } from '../../shared/github';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';
import {
  buildSeedPrompt,
  launchWorkItem,
  workItemSessionName,
  type WorkItemLaunchDeps,
} from './launchWorkItem';

const pr51: WorkItemRef = { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 };

const item51: InboxItem = {
  workItem: pr51,
  title: 'Extract billing client',
  state: 'open',
  role: 'review-requested',
  ciStatus: 'failing',
  reviewDecision: 'REVIEW_REQUIRED',
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sprocket/catalog-portal/pull/51',
  additions: 210,
  deletions: 88,
};

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const now = Date.now();
  return {
    id: 'ws-1',
    name: 'Sprocket',
    defaultHarnessId: 'default',
    scopes: [
      { id: 'scope-container', name: 'sprocket', path: '/repos', isGitRepo: false, createdAt: now },
      { id: 'scope-controller', name: 'catalog-portal', path: '/repos/catalog-portal', isGitRepo: true, createdAt: now },
    ],
    groups: [],
    github: { accountLogin: 'JaviDev', org: 'sprocket' },
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
    resolveRepo: () => '/repos/catalog-portal',
    ensureWorktree: vi.fn(async () => '/worktrees/catalog-portal-pr-51'),
    composeEnv: async () => ({ GH_TOKEN: 'gho_test' }),
    findItem: () => item51,
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
      cwd: '/worktrees/catalog-portal-pr-51',
      kind: 'interactive',
      workItem: { ...pr51, repo: 'Sprocket/Catalog-Portal' }, // casing differs on purpose
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
      cwd: '/worktrees/catalog-portal-pr-51',
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

describe('buildSeedPrompt', () => {
  it('describes the item and the worktree, and starts from gh view', () => {
    const prompt = buildSeedPrompt(pr51, item51);
    expect(prompt).toContain('pull request #51');
    expect(prompt).toContain('Extract billing client');
    expect(prompt).toContain('sprocket/catalog-portal');
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
