import { describe, expect, it, vi } from 'vitest';
import type { InboxItem, WorkItemRef } from '../../shared/workItems';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from './GitProviderDriver';
import {
  buildSeedPrompt,
  createLaunchCoalescer,
  launchWorkItem,
  workItemSessionName,
  type WorkItemLaunchDeps,
} from './launchWorkItem';
import { createStubDriver } from './stubDriver.test-helpers';

const pr51: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };
const issue87: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'issue', number: 87 };

const item51: InboxItem = {
  workItem: pr51,
  title: 'Extract billing client',
  author: 'anna',
  roles: ['review-requested-direct'],
  isDraft: false,
  state: 'open',
  reviewDecision: 'review-required',
  ciStatus: 'failing',
  commentCount: 3,
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sympower/controller-app/pull/51',
  additions: 210,
  deletions: 88,
};

const REVIEW_BODY =
  'Review the changes and summarise your findings before writing any review comments.';
const IMPLEMENT_BODY = 'Investigate it and propose a plan before changing anything.';

/**
 * This file's flavour of the shared stub: a token tied to the login (so a
 * launch's composed env proves which account it borrowed for).
 */
function makeStubDriver(overrides: Partial<GitProviderDriver> = {}): GitProviderDriver {
  return createStubDriver({
    tokenEnvVar: 'STUB_TOKEN',
    token: vi.fn(async (login: string) => `tok-${login}`),
    ...overrides,
  });
}

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
    actions: [],
    sectionDefaults: {},
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDeps(workspace: Workspace, overrides: Partial<WorkItemLaunchDeps> = {}) {
  const created: NewSessionFields[] = [];
  const driver = makeStubDriver();
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
    composeEnv: vi.fn(async (resolved, login) => ({ [resolved.tokenEnvVar]: `tok-${login}` })),
    findItem: () => item51,
    pathExists: () => true,
    resolveDriver: () => driver,
    ...overrides,
  };
  return { deps, created, driver };
}

function existingSession(overrides: Partial<Session> = {}): Session {
  return {
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
    workItemAction: 'Review',
    createdAt: 1,
    lastActiveAt: 1,
    ...overrides,
  };
}

describe('launchWorkItem', () => {
  it('re-attaches to an existing session for the same work item, touching nothing', async () => {
    // Casing differs on purpose: repo identity is case-insensitive.
    const existing = existingSession({ workItem: { ...pr51, repo: 'Sympower/Controller-App' } });
    const workspace = makeWorkspace({ sessions: [existing] });
    const { deps, created } = makeDeps(workspace);

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: true, session: existing, reattached: true });
    expect(created).toHaveLength(0);
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });

  it('re-ensures a deleted worktree before re-attaching, with the env the driver composed', async () => {
    const existing = existingSession();
    const workspace = makeWorkspace({ sessions: [existing] });
    const { deps, created, driver } = makeDeps(workspace, { pathExists: () => false });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: true, session: existing, reattached: true });
    expect(created).toHaveLength(0);
    expect(deps.composeEnv).toHaveBeenCalledWith(driver, 'SymJavi');
    expect(deps.ensureWorktree).toHaveBeenCalledWith('/repos/controller-app', pr51, {
      STUB_TOKEN: 'tok-SymJavi',
    });
  });

  it('re-attaches without ensuring anything when the clone itself is gone too', async () => {
    const workspace = makeWorkspace({ sessions: [existingSession()] });
    const { deps } = makeDeps(workspace, { pathExists: () => false, resolveRepo: () => null });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    // The clone can't be resolved, so there's nothing to rebuild the
    // worktree from — the honest answer is today's re-attach, which hands
    // the user the existing terminal's "working folder not found" notice.
    expect(result).toMatchObject({ ok: true, reattached: true });
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });

  it('surfaces ensureWorktree failure as the launch error rather than re-attaching into a broken directory', async () => {
    const workspace = makeWorkspace({ sessions: [existingSession()] });
    const { deps } = makeDeps(workspace, {
      pathExists: () => false,
      ensureWorktree: vi.fn(async () => {
        throw new Error('fatal: unable to recreate worktree');
      }),
    });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: false, reason: 'error', message: 'fatal: unable to recreate worktree' });
  });

  it('reports not-cloned when no scope resolves the repo, creating nothing', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), { resolveRepo: () => null });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: false, reason: 'not-cloned' });
    expect(created).toHaveLength(0);
  });

  it('creates no session record when the worktree step fails — atomicity', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), {
      ensureWorktree: vi.fn(async () => {
        throw new Error('fatal: not a valid ref');
      }),
    });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: false, reason: 'error', message: 'fatal: not a valid ref' });
    expect(created).toHaveLength(0);
  });

  it('creates the record with the matched scope, worktree cwd, work item and the action name', async () => {
    const { deps, created } = makeDeps(makeWorkspace());

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reattached).toBe(false);
    // The driver's header, a blank line, then the type's default body.
    expect(result.seedPrompt).toBe(`stub header for #51 (Extract billing client)\n\n${REVIEW_BODY}`);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: 'PR #51 - Extract billing client',
      workspaceId: 'ws-1',
      harnessId: 'default',
      scopeId: 'scope-controller', // deepest matching scope, not the container
      cwd: '/worktrees/controller-app-pr-51',
      kind: 'interactive',
      workItem: pr51,
      workItemAction: 'Review',
    });
    expect(created[0].instanceId).toMatch(/^workspace-ws-1-session-/);
  });

  it('labels an issue launch Implement and seeds the Implement body', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), {
      ensureWorktree: vi.fn(async () => '/worktrees/controller-app-issue-87'),
      findItem: () => undefined,
    });

    const result = await launchWorkItem(deps, 'ws-1', issue87);

    expect(result).toMatchObject({
      ok: true,
      seedPrompt: `stub header for #87\n\n${IMPLEMENT_BODY}`,
    });
    expect(created[0]).toMatchObject({ name: 'Issue #87', workItemAction: 'Implement' });
  });

  it('errors plainly for a workspace without a provider binding', async () => {
    const { deps, created } = makeDeps(makeWorkspace({ provider: undefined }));

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({
      ok: false,
      reason: 'error',
      message: 'This workspace has no provider account bound.',
    });
    expect(created).toHaveLength(0);
  });

  it('errors, creating nothing, when the provider is unknown to this build', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), {
      resolveDriver: () => {
        throw new Error('Unknown git provider "gitlab".');
      },
    });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: false, reason: 'error', message: 'Unknown git provider "gitlab".' });
    expect(created).toHaveLength(0);
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });
});

describe('createLaunchCoalescer', () => {
  it('coalesces concurrent launches of the same work item into one call', async () => {
    const { deps, created } = makeDeps(makeWorkspace());
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
    const { deps, created } = makeDeps(makeWorkspace());
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
  it("is the driver's header, a blank line, and the Review body for a PR", () => {
    expect(buildSeedPrompt(makeStubDriver(), pr51, item51)).toBe(
      `stub header for #51 (Extract billing client)\n\n${REVIEW_BODY}`
    );
  });

  it('is the header and the Implement body for an issue, with no cached item', () => {
    expect(buildSeedPrompt(makeStubDriver(), issue87)).toBe(`stub header for #87\n\n${IMPLEMENT_BODY}`);
  });
});

describe('workItemSessionName', () => {
  it('uses the title when the inbox holds one, a plain label when not', () => {
    expect(workItemSessionName(pr51, item51)).toBe('PR #51 - Extract billing client');
    expect(workItemSessionName(pr51)).toBe('PR #51');
    expect(workItemSessionName(issue87)).toBe('Issue #87');
  });
});
