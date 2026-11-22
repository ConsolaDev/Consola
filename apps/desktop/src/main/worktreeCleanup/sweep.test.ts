import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, Workspace } from '../../shared/workspace';
import {
  DEFAULT_WORKTREE_CLEANUP_RULES,
  effectiveWorktreeCleanup,
  type WorktreeCleanupRules,
} from '../../shared/worktreeCleanup';
import type { GitProviderDriver } from '../providers/GitProviderDriver';
import type { PullRequestQuery, PullRequestState } from '../providers/pullRequests';
import { WorktreeService } from '../WorktreeService';
import { WorktreeCleanupService } from '.';
import { treeHeldByRun } from './FactGatherer';
import { PathLock } from './PathLock';

/**
 * The rules applied across workspaces, against real git: what a sweep
 * removes, and everything that keeps a worktree where it is.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const created: string[] = [];
afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

const DAY = 24 * 60 * 60_000;
const NOW = Date.now();
const SETTLED: WorktreeCleanupRules = { ...DEFAULT_WORKTREE_CLEANUP_RULES, settledDays: 3 };

class Rig {
  readonly base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-sweep-')));
  readonly origin = path.join(this.base, 'origin.git');
  readonly clone = path.join(this.base, 'app');
  readonly root = path.join(this.base, 'worktrees');
  readonly worktrees = new WorktreeService(this.root);
  global: WorktreeCleanupRules = SETTLED;
  readonly shown = new Set<string>();
  /** The folders an automation run holds as its checkout, as the engine names them. */
  readonly heldByRuns = new Set<string>();
  readonly settledAt = new Map<string, number>();
  readonly prs = new Map<string, PullRequestState[]>();
  lookups = 0;
  readonly workspaces: Workspace[] = [];
  private sequence = 0;

  constructor() {
    created.push(this.base);
    fs.mkdirSync(this.root);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', this.origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', this.clone]);
    git(this.clone, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
    git(this.clone, 'config', 'remote.origin.url', this.origin);
    fs.writeFileSync(path.join(this.clone, 'README'), 'hi');
    git(this.clone, 'add', '.');
    git(this.clone, 'commit', '-q', '-m', 'init');
    git(this.clone, 'push', '-q', 'origin', 'main');
    this.workspace('ws-1');
  }

  workspace(id: string, worktreeCleanup?: Workspace['worktreeCleanup']): Workspace {
    const workspace: Workspace = {
      id,
      name: id,
      defaultHarnessId: 'claude',
      scopes: [{ id: `${id}-scope`, name: 'app', path: this.clone, isGitRepo: true, createdAt: 0 }],
      groups: [],
      labels: [],
      provider: { id: 'github', accountLogin: 'me' },
      actions: [],
      sectionDefaults: {},
      sessions: [],
      createdAt: 0,
      updatedAt: 0,
      ...(worktreeCleanup ? { worktreeCleanup } : {}),
    };
    this.workspaces.push(workspace);
    return workspace;
  }

  /** A pushed worktree with a session in it, settled four days ago. */
  tree(branch: string): string {
    const dir = path.join(this.root, `app-session-${++this.sequence}`);
    git(this.clone, 'worktree', 'add', '-q', '-b', branch, dir);
    fs.writeFileSync(path.join(dir, 'work.txt'), branch);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'work');
    git(dir, 'push', '-q', '-u', 'origin', branch);
    return dir;
  }

  session(name: string, cwd: string, workspaceId = 'ws-1', extra: Partial<Session> = {}): Session {
    const id = `s-${++this.sequence}`;
    const session: Session = {
      id,
      name,
      workspaceId,
      instanceId: `i-${id}`,
      claudeSessionId: id,
      hasStarted: true,
      harnessId: 'claude',
      scopeId: `${workspaceId}-scope`,
      kind: 'interactive',
      cwd,
      createdAt: 0,
      lastActiveAt: NOW - 5 * DAY,
      ...extra,
    };
    this.workspaces.find((workspace) => workspace.id === workspaceId)!.sessions.push(session);
    this.settledAt.set(id, NOW - 4 * DAY);
    return session;
  }

  service(): WorktreeCleanupService {
    const driver = {
      repoOfRemote: () => 'acme/app',
      lookupPullRequests: async (queries: PullRequestQuery[]) => {
        this.lookups++;
        return queries.map((query) => ({
          query,
          pullRequests:
            this.prs.get('number' in query ? `#${query.number}` : `head:${query.headBranch}`) ?? [],
        }));
      },
    } as unknown as GitProviderDriver;
    const sessions = () => this.workspaces.flatMap((workspace) => workspace.sessions);
    return new WorktreeCleanupService({
      getWorkspaces: () => this.workspaces,
      status: () => 'exited',
      isShown: (instanceId) => this.shown.has(instanceId),
      heldSessionIds: () => new Set(),
      runHolds: (tree) => this.heldByRuns.has(tree),
      lastActiveAt: (session) => session.lastActiveAt,
      ownProcessIds: () => ({ agents: new Set(), shells: new Set() }),
      worktrees: this.worktrees,
      processes: { snapshot: async () => ({ kind: 'ok', entries: [] }) },
      lock: new PathLock(),
      stop: () => {},
      recordRemoved: (entries) => {
        for (const { sessionId, removed } of entries) {
          sessions().find((session) => session.id === sessionId)!.removedWorktree = removed;
        }
      },
      clearRemoved: () => {},
      rules: {
        rulesFor: (workspace) => effectiveWorktreeCleanup(this.global, workspace.worktreeCleanup),
        settledAt: (session) => this.settledAt.get(session.id) ?? null,
        runEndedAt: () => undefined,
      },
      pullRequests: {
        driverFor: () => driver,
        composeEnv: async () => process.env,
      },
      now: () => NOW,
      sleep: async () => {},
    });
  }
}

let rig: Rig;
beforeEach(() => {
  rig = new Rig();
});

describe('sweep', () => {
  it('removes a settled worktree, keeps the session, and marks it removed', async () => {
    const dir = rig.tree('consola/session-a');
    const session = rig.session('Done', dir);
    const report = await rig.service().sweep();

    expect(report.removed.map((entry) => entry.tree)).toEqual([dir]);
    expect(report.summary).toBe('Removed 1 worktree.');
    expect(fs.existsSync(dir)).toBe(false);
    expect(session.removedWorktree).toMatchObject({ path: dir, trigger: 'settled' });
    // A removed worktree is nobody's tree any more: the next sweep finds nothing.
    expect((await rig.service().sweep()).removed).toEqual([]);
  });

  it('removes nothing with every rule off, and nothing in a workspace set to Off', async () => {
    const dir = rig.tree('consola/session-a');
    rig.session('Done', dir);
    rig.global = DEFAULT_WORKTREE_CLEANUP_RULES;
    expect(await rig.service().sweep()).toMatchObject({ removed: [], kept: [] });

    rig.global = SETTLED;
    rig.workspaces[0].worktreeCleanup = { mode: 'off' };
    expect((await rig.service().sweep()).removed).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);

    // Custom rules replace the global ones, in that workspace only.
    rig.global = DEFAULT_WORKTREE_CLEANUP_RULES;
    rig.workspaces[0].worktreeCleanup = { mode: 'custom', rules: SETTLED };
    expect((await rig.service().sweep()).removed).toHaveLength(1);
  });

  it('skips a session open in a window, and one active within the hour', async () => {
    const shown = rig.tree('consola/shown');
    const active = rig.tree('consola/active');
    rig.shown.add(rig.session('Shown', shown).instanceId);
    rig.session('Active', active, 'ws-1', { lastActiveAt: NOW - 10 * 60_000 });
    rig.settledAt.set(rig.workspaces[0].sessions[1].id, NOW - 4 * DAY);

    const preview = await rig.service().scan();
    expect(preview.removable).toBe(0);
    expect(preview.entries.map((entry) => entry.reason)).toEqual([
      '"Shown" is open in a window',
      '"Active" was active 10 minutes ago',
    ]);
    await rig.service().sweep();
    expect(fs.existsSync(shown) && fs.existsSync(active)).toBe(true);
  });

  it('keeps the checkout of a run parked at a gate, its step session settled for days (3-A code review S1)', async () => {
    const dir = rig.tree('consola/parked');
    rig.session('look', dir, 'ws-1', {
      automation: { name: 'review-gated', runId: 'run-1', step: { id: 'look', attempt: 1 } },
    });
    rig.heldByRuns.add(dir);
    const preview = await rig.service().scan();
    expect(preview.removable).toBe(0);
    expect(preview.entries.map((entry) => entry.reason)).toEqual([
      'An automation run is holding it',
    ]);
    expect((await rig.service().sweep()).removed).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
    // Answered and ended, the run lets go: the rule removes it.
    rig.heldByRuns.delete(dir);
    expect((await rig.service().sweep()).removed.map((entry) => entry.tree)).toEqual([dir]);
  });

  it("reads a run's checkout through the tree's own resolution (3-A code review S1)", () => {
    const dir = rig.tree('consola/parked');
    const other = rig.tree('consola/other');
    // The run names its checkout as it built the path: here through a link to the root.
    const linked = path.join(rig.base, 'linked-root');
    fs.symlinkSync(rig.root, linked);
    const named = path.join(linked, path.basename(dir));
    expect(treeHeldByRun(dir, [dir], rig.worktrees)).toBe(true);
    expect(treeHeldByRun(dir, [named], rig.worktrees)).toBe(true);
    fs.mkdirSync(path.join(dir, 'src'));
    expect(treeHeldByRun(dir, [path.join(named, 'src')], rig.worktrees)).toBe(true);
    expect(treeHeldByRun(dir, [other], rig.worktrees)).toBe(false);
    expect(treeHeldByRun(dir, [], rig.worktrees)).toBe(false);
  });

  it('keeps a worktree shared with a session whose workspace is Off', async () => {
    const dir = rig.tree('consola/shared');
    rig.session('Here', dir);
    rig.workspace('ws-off', { mode: 'off' });
    rig.session('There', dir, 'ws-off');
    expect((await rig.service().sweep()).removed).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('removes a worktree whose pull request finished, asking the provider once per batch', async () => {
    rig.global = { ...DEFAULT_WORKTREE_CLEANUP_RULES, prFinished: true };
    const merged = rig.tree('feature-a');
    const open = rig.tree('feature-b');
    rig.session('Merged', merged);
    rig.session('Open', open);
    rig.prs.set('head:feature-a', [
      {
        number: 1,
        status: 'merged',
        headOid: git(merged, 'rev-parse', 'HEAD'),
        headBranch: 'feature-a',
        url: 'u',
        createdAt: '2026-11-01T00:00:00Z',
      },
    ]);
    rig.prs.set('head:feature-b', [
      {
        number: 2,
        status: 'open',
        headOid: git(open, 'rev-parse', 'HEAD'),
        headBranch: 'feature-b',
        url: 'u',
        createdAt: '2026-11-01T00:00:00Z',
      },
    ]);
    const service = rig.service();
    const report = await service.sweep({ refreshPullRequests: true });
    expect(report.removed.map((entry) => entry.tree)).toEqual([merged]);
    expect(report.kept.map((entry) => entry.reason)).toEqual(['Pull request #2 is still open']);
    expect(rig.lookups).toBe(1);
    // A fresh answer is reused, not asked for again.
    await service.scan();
    expect(rig.lookups).toBe(1);
  });

  it('previews what turning a rule on would remove, without changing anything', async () => {
    rig.global = DEFAULT_WORKTREE_CLEANUP_RULES;
    const dir = rig.tree('consola/session-a');
    rig.session('Done', dir);
    const preview = await rig.service().scan({ rulesFor: () => SETTLED });
    expect(preview).toMatchObject({ removable: 1, summary: 'Would remove 1 worktree.' });
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('deleting a session', () => {
  const ON: WorktreeCleanupRules = { ...DEFAULT_WORKTREE_CLEANUP_RULES, sessionDeleted: true };

  /** Delete through the facade, the record removed the way main removes it. */
  async function remove(session: Session) {
    const workspace = rig.workspaces.find((candidate) => candidate.id === session.workspaceId)!;
    let settled: (value: unknown) => void = () => {};
    const done = new Promise((resolve) => {
      settled = resolve;
    });
    const outcome = await rig.service().deleteForPerson(
      workspace,
      session,
      () => {
        workspace.sessions = workspace.sessions.filter((candidate) => candidate.id !== session.id);
      },
      (final) => settled(final),
    );
    return { outcome, final: outcome.worktree === 'removing' ? await done : undefined };
  }

  it('is a plain delete while the rule is off', async () => {
    rig.global = DEFAULT_WORKTREE_CLEANUP_RULES;
    const dir = rig.tree('consola/session-a');
    const session = rig.session('Done', dir);
    const workspace = rig.workspaces[0];
    expect(await rig.service().previewDelete(workspace, session)).toEqual({ worktree: null });
    expect((await remove(session)).outcome).toEqual({ worktree: 'none', branch: 'none' });
    expect(rig.workspaces[0].sessions).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('says what will happen, then takes the worktree and a consola/ branch with it', async () => {
    rig.global = ON;
    const dir = rig.tree('consola/session-a');
    const session = rig.session('Done', dir, 'ws-1', { lastActiveAt: NOW });
    rig.shown.add(session.instanceId);
    expect(await rig.service().previewDelete(rig.workspaces[0], session)).toEqual({
      worktree: 'Its worktree and branch consola/session-a will be removed too.',
    });

    const { outcome, final } = await remove(session);
    expect(outcome).toEqual({ worktree: 'removing', branch: 'none' });
    expect(final).toEqual({
      worktree: 'removed',
      branch: 'deleted',
      message: 'Deleted “Done”, its worktree and branch consola/session-a.',
    });
    expect(fs.existsSync(dir)).toBe(false);
    expect(git(rig.clone, 'branch', '--list', 'consola/session-a')).toBe('');
  });

  it('keeps a person’s own branch, and a worktree with changes', async () => {
    rig.global = ON;
    const own = rig.tree('feature/mine');
    const ownSession = rig.session('Mine', own);
    expect(await rig.service().previewDelete(rig.workspaces[0], ownSession)).toEqual({
      worktree: 'Its worktree will be removed too; branch feature/mine stays.',
    });

    const dirty = rig.tree('consola/dirty');
    fs.writeFileSync(path.join(dirty, 'wip.txt'), 'unsaved');
    const dirtySession = rig.session('Dirty', dirty);
    expect(await rig.service().previewDelete(rig.workspaces[0], dirtySession)).toEqual({
      worktree: 'Its worktree stays: 1 file has uncommitted changes.',
    });
    const { final } = await remove(dirtySession);
    expect(final).toMatchObject({
      worktree: 'kept',
      message: 'Deleted “Dirty”. Its worktree stays: 1 file has uncommitted changes.',
    });
    expect(fs.existsSync(path.join(dirty, 'wip.txt'))).toBe(true);
    // The session is gone either way: deleting is what the person asked for.
    expect(rig.workspaces[0].sessions.map((session) => session.name)).toEqual(['Mine']);
  });

  it('keeps a worktree another session still uses', async () => {
    rig.global = ON;
    const dir = rig.tree('consola/shared');
    const going = rig.session('Going', dir);
    rig.session('Staying', dir);
    expect(await rig.service().previewDelete(rig.workspaces[0], going)).toEqual({
      worktree: 'Its worktree stays: "Staying" still uses it.',
    });
    const { final } = await remove(going);
    expect(final).toMatchObject({ worktree: 'kept' });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('keeps the checkout a run holds when its step session is deleted (3-A code review S1)', async () => {
    rig.global = ON;
    const dir = rig.tree('consola/parked');
    const step = rig.session('look', dir, 'ws-1', {
      automation: { name: 'review-gated', runId: 'run-1', step: { id: 'look', attempt: 1 } },
    });
    rig.heldByRuns.add(dir);
    expect(await rig.service().previewDelete(rig.workspaces[0], step)).toEqual({
      worktree: 'Its worktree stays: an automation run is holding it.',
    });
    const { final } = await remove(step);
    expect(final).toMatchObject({ worktree: 'kept' });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('deletes the branch of a session whose worktree a rule already removed', async () => {
    const dir = rig.tree('consola/session-z');
    const session = rig.session('Settled', dir);
    await rig.service().sweep();
    expect(session.removedWorktree).toBeDefined();

    rig.global = ON;
    expect(await rig.service().previewDelete(rig.workspaces[0], session)).toEqual({
      worktree: 'Its worktree was already removed; branch consola/session-z will be deleted too.',
    });
    const { outcome } = await remove(session);
    expect(outcome).toMatchObject({ branch: 'deleted' });
    expect(git(rig.clone, 'branch', '--list', 'consola/session-z')).toBe('');
  });
});
