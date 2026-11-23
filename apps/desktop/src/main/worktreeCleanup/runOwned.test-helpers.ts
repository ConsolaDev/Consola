import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeRunClone, runCloneGitDirFor } from '@consola/automation-engine';
import type { Session, Workspace } from '../../shared/workspace';
import type { RemovedWorktree, WorktreeCleanupRules } from '../../shared/worktreeCleanup';
import { WorktreeService } from '../WorktreeService';
import { WorktreeCleanupService } from '.';
import type { RuleSources } from './FactGatherer';
import { PathLock } from './PathLock';
import { WorktreeRebuilder } from './WorktreeRebuilder';

/*
 * A run's own checkout (slice 3-B) against real git, for the cleanup's
 * tests: a bare remote, the person's clone of it, and a run clone made by
 * the engine's `makeRunClone` under a temp worktree root, its git folder in
 * `run-git/` beside it, with one commit on its branch. Every git here runs
 * with an empty global config and no system config (M1's isolation), and
 * nothing is written outside the rig's temp folder.
 */

export const RUN_ID = '3f2a91c0aabbccdd';
export const BRANCH = 'fix/SHOP-42';
export const KEEP_REF = 'refs/consola/worktrees/catalog-portal-run-3f2a91c0';

export class RunOwnedRig {
  readonly base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-run-owned-')));
  readonly remote = path.join(this.base, 'remote.git');
  readonly source = path.join(this.base, 'catalog-portal');
  readonly root = path.join(this.base, 'worktrees');
  readonly dir = path.join(this.root, 'catalog-portal-run-3f2a91c0');
  readonly gitDir = runCloneGitDirFor(this.dir);
  readonly env: NodeJS.ProcessEnv;
  readonly worktrees: WorktreeService;
  readonly workspace: Workspace;
  /** Session records the executor wrote, in order. */
  readonly recorded: Array<{ sessionId: string; removed: RemovedWorktree }> = [];
  /** What the executor recorded on the run (`recordCheckoutRemoved`), in order. */
  readonly runRecorded: Array<{
    runId: string;
    removed: { commit: string; keepRef: string; at: string } | null;
  }> = [];
  rules: WorktreeCleanupRules | null = null;
  /** The run as history has it, or null once history dropped it. */
  record: { endedAt: number | null } | null = { endedAt: Date.now() - 2 * 60 * 60_000 };
  base0 = '';
  head = '';

  constructor() {
    const global = path.join(this.base, 'gitconfig');
    fs.writeFileSync(global, '');
    this.env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' };
    this.worktrees = new WorktreeService(this.root);
    this.workspace = {
      id: 'ws',
      name: 'Sprocket',
      defaultHarnessId: 'claude',
      scopes: [
        { id: 'scope', name: 'catalog-portal', path: this.source, isGitRepo: true, createdAt: 0 },
      ],
      groups: [],
      labels: [],
      actions: [],
      sectionDefaults: {},
      sessions: [],
      createdAt: 0,
      updatedAt: 0,
    };
  }

  /** git in `cwd`, as the person runs it. */
  git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: this.env }).trim();
  }

  /** git in the run clone, its git folder named: never discovered from the checkout. */
  run(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.dir,
      encoding: 'utf8',
      env: { ...this.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  /** The remote, the person's clone, and the run clone with one commit on its branch. */
  async make(): Promise<this> {
    this.git(this.base, 'init', '-q', '--bare', '-b', 'main', this.remote);
    this.git(this.base, 'clone', '-q', this.remote, this.source);
    this.git(this.source, 'config', 'user.name', 'alice');
    this.git(this.source, 'config', 'user.email', 'alice@sprocket.example');
    fs.writeFileSync(path.join(this.source, 'README.md'), 'catalog-portal\n');
    this.git(this.source, 'add', '-A');
    this.git(this.source, 'commit', '-q', '-m', 'first');
    this.git(this.source, 'push', '-q', 'origin', 'HEAD:main');
    const made = await makeRunClone({
      source: this.source,
      dir: this.dir,
      branch: BRANCH,
      runId: RUN_ID,
      fetchEnv: this.env,
    });
    this.base0 = made.base;
    fs.writeFileSync(path.join(this.dir, 'fix.txt'), 'fixed\n');
    this.run('add', '-A');
    this.run('commit', '-q', '-m', 'fix');
    this.head = this.run('rev-parse', 'HEAD');
    return this;
  }

  /** Push the run's branch, so its commit is on the remote. */
  push(): void {
    this.run('push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
  }

  /** A step's session in the run's checkout, settled and idle long ago. */
  session(): Session {
    const session: Session = {
      id: 's-step',
      name: 'ui-bugfixer',
      workspaceId: 'ws',
      instanceId: 'i-step',
      claudeSessionId: 'c-step',
      hasStarted: true,
      harnessId: 'claude',
      scopeId: 'scope',
      kind: 'interactive',
      cwd: this.dir,
      createdAt: 0,
      lastActiveAt: Date.now() - 5 * 24 * 60 * 60_000,
      toolPolicy: 'write',
      automation: { name: 'ui-bug-to-pr', runId: RUN_ID, step: { id: 'fix', attempt: 1 } },
    };
    this.workspace.sessions.push(session);
    return session;
  }

  ruleSources(): RuleSources {
    return {
      rulesFor: () => this.rules,
      settledAt: () => null,
      runEndedAt: () => (this.record ? this.record.endedAt : undefined),
      runOwnedOf: (tree) =>
        this.record && tree === this.dir
          ? { runId: RUN_ID, source: this.source, endedAt: this.record.endedAt, workspaceId: 'ws' }
          : null,
    };
  }

  service(over: { rules?: RuleSources; worktrees?: WorktreeService } = {}): WorktreeCleanupService {
    return new WorktreeCleanupService({
      getWorkspaces: () => [this.workspace],
      status: () => 'exited',
      isShown: () => false,
      heldSessionIds: () => new Set(),
      runHolds: () => false,
      lastActiveAt: (session) => session.lastActiveAt,
      ownProcessIds: () => ({ agents: new Set(), shells: new Set() }),
      worktrees: over.worktrees ?? this.worktrees,
      processes: { snapshot: async () => ({ kind: 'ok', entries: [] }) },
      lock: new PathLock(),
      stop: () => {},
      recordRemoved: (entries) => {
        for (const entry of entries) {
          this.recorded.push(entry);
          const session = this.workspace.sessions.find((s) => s.id === entry.sessionId);
          if (session) session.removedWorktree = entry.removed;
        }
      },
      clearRemoved: (worktreePath) => {
        for (const session of this.workspace.sessions) {
          if (session.removedWorktree?.path === worktreePath) delete session.removedWorktree;
        }
      },
      recordRunCheckoutRemoved: (runId, removed) => this.runRecorded.push({ runId, removed }),
      rules: over.rules ?? this.ruleSources(),
      now: () => Date.now(),
      sleep: async () => {},
    });
  }

  /** The run's own record of the removal, as main reads it from history. */
  runRecordAt(dir: string): RemovedWorktree | undefined {
    const last = this.runRecorded.at(-1);
    if (dir !== this.dir || !last?.removed) return undefined;
    return {
      path: this.dir,
      mainRepo: this.source,
      commit: last.removed.commit,
      branch: BRANCH,
      keepRef: last.removed.keepRef,
      trigger: 'run-finished',
      removedAt: Date.parse(last.removed.at),
      kind: 'run-owned',
      runId: last.runId,
    };
  }

  rebuilder(): WorktreeRebuilder {
    return new WorktreeRebuilder({
      lock: new PathLock(),
      getWorkspaces: () => [this.workspace],
      worktrees: this.worktrees,
      clearRemoved: (worktreePath) => {
        for (const session of this.workspace.sessions) {
          if (session.removedWorktree?.path === worktreePath) delete session.removedWorktree;
        }
      },
      runRecordAt: (dir) => this.runRecordAt(dir),
      clearRunRecord: (runId) => this.runRecorded.push({ runId, removed: null }),
    });
  }

  dispose(): void {
    fs.rmSync(this.base, { recursive: true, force: true });
  }
}
