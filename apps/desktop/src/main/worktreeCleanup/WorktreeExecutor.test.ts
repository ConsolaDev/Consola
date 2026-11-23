import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStatus } from '../../shared/terminalStatus';
import type { Session, Workspace } from '../../shared/workspace';
import { DEFAULT_WORKTREE_CLEANUP_RULES, type RemovedWorktree } from '../../shared/worktreeCleanup';
import { WorktreeService } from '../WorktreeService';
import { WorktreeCleanupService } from '.';
import type { GatherOptions } from './FactGatherer';
import { PathLock } from './PathLock';
import type { ProcessSnapshot } from './ProcessCwdIndex';
import { runCloneGitDirFor } from '@consola/automation-engine';
import { BRANCH, KEEP_REF, RUN_ID, RunOwnedRig } from './runOwned.test-helpers';

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

class Rig {
  readonly base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-exec-')));
  readonly origin = path.join(this.base, 'origin.git');
  readonly clone = path.join(this.base, 'app');
  readonly root = path.join(this.base, 'worktrees');
  readonly worktrees = new WorktreeService(this.root);
  readonly stopped: string[] = [];
  readonly records = new Map<string, RemovedWorktree>();
  readonly statuses = new Map<string, TerminalStatus>();
  /** What the process check sees: before the sessions stop, and after. */
  processes: { before: ProcessSnapshot; after: ProcessSnapshot } = {
    before: { kind: 'ok', entries: [] },
    after: { kind: 'ok', entries: [] },
  };
  failRemoval = false;
  /** Runs while the slow checks run: something changing under a removal. */
  duringChecks: () => void = () => {};
  /** Delete the folder before failing, like a removal that broke part-way. */
  removalBreaksFolder = false;
  workspace: Workspace;
  private sequence = 0;

  constructor() {
    created.push(this.base);
    fs.mkdirSync(this.root);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', this.origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', this.clone]);
    git(this.clone, 'remote', 'add', 'origin', this.origin);
    fs.writeFileSync(path.join(this.clone, 'README'), 'hi');
    git(this.clone, 'add', '.');
    git(this.clone, 'commit', '-q', '-m', 'init');
    git(this.clone, 'push', '-q', 'origin', 'main');
    this.workspace = {
      id: 'ws',
      name: 'Acme',
      defaultHarnessId: 'claude',
      scopes: [{ id: 'scope', name: 'app', path: this.clone, isGitRepo: true, createdAt: 0 }],
      groups: [],
      labels: [],
      actions: [],
      sectionDefaults: {},
      sessions: [],
      createdAt: 0,
      updatedAt: 0,
    };
  }

  /** A pushed worktree on `branch` with one commit, and a settled session in it. */
  tree(branch: string): { dir: string; head: string; session: Session } {
    const dir = path.join(this.root, `app-session-${++this.sequence}`);
    git(this.clone, 'worktree', 'add', '-q', '-b', branch, dir);
    fs.writeFileSync(path.join(dir, `${this.sequence}.txt`), 'work');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'work');
    git(dir, 'push', '-q', '-u', 'origin', branch);
    const session: Session = {
      id: `s-${this.sequence}`,
      name: `Session ${this.sequence}`,
      workspaceId: 'ws',
      instanceId: `i-${this.sequence}`,
      claudeSessionId: `c-${this.sequence}`,
      hasStarted: true,
      harnessId: 'claude',
      scopeId: 'scope',
      kind: 'interactive',
      cwd: dir,
      createdAt: 0,
      lastActiveAt: Date.now() - 5 * DAY,
    };
    this.workspace.sessions.push(session);
    return { dir, head: git(dir, 'rev-parse', 'HEAD'), session };
  }

  service(): WorktreeCleanupService {
    let stoppedYet = false;
    const worktrees = this.worktrees;
    return new WorktreeCleanupService({
      getWorkspaces: () => [this.workspace],
      status: (instanceId) => this.statuses.get(instanceId) ?? 'exited',
      isShown: () => false,
      heldSessionIds: () => new Set(),
      runHolds: () => false,
      lastActiveAt: (session) => session.lastActiveAt,
      ownProcessIds: () => ({ agents: new Set(), shells: new Set() }),
      worktrees: Object.assign(Object.create(worktrees), {
        removeWorktree: async (inspection: Parameters<WorktreeService['removeWorktree']>[0]) => {
          if (this.removalBreaksFolder) fs.rmSync(inspection.toplevel, { recursive: true });
          if (this.failRemoval) throw new Error('git refused');
          return worktrees.removeWorktree(inspection);
        },
        nestedRepos: async (tree: string) => {
          this.duringChecks();
          return worktrees.nestedRepos(tree);
        },
      }) as WorktreeService,
      processes: {
        snapshot: async () => (stoppedYet ? this.processes.after : this.processes.before),
      },
      lock: new PathLock(),
      stop: (session) => {
        stoppedYet = true;
        this.stopped.push(session.instanceId);
      },
      recordRemoved: (entries) => {
        for (const { sessionId, removed } of entries) {
          this.records.set(sessionId, removed);
          const session = this.workspace.sessions.find((candidate) => candidate.id === sessionId)!;
          session.removedWorktree = removed;
        }
      },
      clearRemoved: (worktreePath) => {
        for (const session of this.workspace.sessions) {
          if (session.removedWorktree?.path === worktreePath) delete session.removedWorktree;
        }
        for (const [id, record] of this.records) {
          if (record.path === worktreePath) this.records.delete(id);
        }
      },
      rules: {
        rulesFor: () => ({ ...DEFAULT_WORKTREE_CLEANUP_RULES, settledDays: 1 }),
        settledAt: () => Date.now() - 3 * DAY,
        runEndedAt: () => undefined,
      },
      now: () => Date.now(),
      sleep: async () => {},
    });
  }
}

const sweep = (): GatherOptions => ({
  request: { trigger: 'sweep', targets: new Set(), now: Date.now() },
});
const deleting = (sessionId: string): GatherOptions => ({
  request: { trigger: 'session-deleted', targets: new Set([sessionId]), now: Date.now() },
});

let rig: Rig;
beforeEach(() => {
  rig = new Rig();
});

describe('WorktreeExecutor', () => {
  it('removes a settled worktree, keeping its branch, a keep-ref and a record to rebuild from', async () => {
    const { dir, head, session } = rig.tree('consola/session-a');
    const result = await rig.service().remove(dir, sweep());

    expect(result).toMatchObject({ kind: 'removed', branch: 'kept' });
    expect(fs.existsSync(dir)).toBe(false);
    expect(rig.stopped).toEqual([session.instanceId]);
    expect(git(rig.clone, 'rev-parse', 'consola/session-a')).toBe(head);
    expect(git(rig.clone, 'rev-parse', 'refs/consola/worktrees/app-session-1')).toBe(head);
    expect(rig.records.get(session.id)).toMatchObject({
      path: dir,
      mainRepo: rig.clone,
      commit: head,
      branch: 'consola/session-a',
      keepRef: 'refs/consola/worktrees/app-session-1',
      trigger: 'settled',
    });
  });

  it('keeps a tree that turned dirty between the preview and the removal', async () => {
    const { dir, session } = rig.tree('consola/session-a');
    const service = rig.service();
    expect((await service.evaluateTree(dir, sweep())).verdict.decision).toBe('remove');

    fs.writeFileSync(path.join(dir, 'wip.txt'), 'typed since');
    const result = await service.remove(dir, sweep());

    expect(result).toMatchObject({ kind: 'kept', verdict: { blockers: [{ kind: 'dirty' }] } });
    expect(fs.existsSync(path.join(dir, 'wip.txt'))).toBe(true);
    expect(rig.stopped).toEqual([]);
    expect(rig.records.has(session.id)).toBe(false);
  });

  it('aborts when a process is still in the folder after the sessions stop', async () => {
    const { dir, session } = rig.tree('consola/session-a');
    rig.processes.after = {
      kind: 'ok',
      entries: [{ pid: 4242, command: 'vite', cwd: path.join(dir, 'web') }],
    };
    const result = await rig.service().remove(dir, sweep());

    expect(result).toMatchObject({
      kind: 'kept',
      verdict: { blockers: [{ kind: 'process', detail: 'vite is still running in it' }] },
    });
    expect(fs.existsSync(dir)).toBe(true);
    expect(rig.records.has(session.id)).toBe(false);
    expect(() =>
      git(rig.clone, 'rev-parse', '--verify', '-q', 'refs/consola/worktrees/app-session-1'),
    ).toThrow();
  });

  it('clears the records when git refuses the removal', async () => {
    const { dir, session } = rig.tree('consola/session-a');
    rig.failRemoval = true;
    const result = await rig.service().remove(dir, sweep());

    expect(result).toMatchObject({ kind: 'failed', error: 'git refused' });
    expect(session.removedWorktree).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(true);
    expect(() =>
      git(rig.clone, 'rev-parse', '--verify', '-q', 'refs/consola/worktrees/app-session-1'),
    ).toThrow();
  });

  it('judges the sessions again after the slow checks: one that started working keeps the tree', async () => {
    const { dir, session } = rig.tree('consola/session-a');
    rig.duringChecks = () => rig.statuses.set(session.instanceId, 'working');
    const result = await rig.service().remove(dir, sweep());

    expect(result).toMatchObject({ kind: 'kept', verdict: { blockers: [{ kind: 'busy' }] } });
    expect(rig.stopped).toEqual([]);
    expect(rig.records.size).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('never stops or records a session that started on the tree after it was judged', async () => {
    const { dir } = rig.tree('consola/session-a');
    rig.duringChecks = () => {
      rig.workspace.sessions.push({
        ...rig.workspace.sessions[0],
        id: 's-late',
        name: 'Late arrival',
        instanceId: 'i-late',
        lastActiveAt: Date.now(),
      });
    };
    const result = await rig.service().remove(dir, sweep());

    expect(result).toMatchObject({ kind: 'kept' });
    expect(rig.stopped).toEqual([]);
    expect(rig.records.size).toBe(0);
  });

  it('keeps the record and keep-ref when a removal failed with the folder already gone', async () => {
    const { dir, session } = rig.tree('consola/session-a');
    rig.failRemoval = true;
    rig.removalBreaksFolder = true;
    const result = await rig.service().remove(dir, sweep());

    expect(result).toMatchObject({
      kind: 'failed',
      error: 'git refused Opening its session rebuilds it.',
    });
    expect(session.removedWorktree).toMatchObject({ path: dir });
    expect(git(rig.clone, 'rev-parse', 'refs/consola/worktrees/app-session-1')).toBe(
      session.removedWorktree!.commit,
    );
  });

  it('on a delete, takes a consola/ branch with it, compare-and-swap at the checked commit', async () => {
    const mine = rig.tree('consola/session-a');
    const result = await rig.service().remove(mine.dir, deleting(mine.session.id));
    expect(result).toMatchObject({ kind: 'removed', branch: 'deleted' });
    expect(git(rig.clone, 'branch', '--list', 'consola/session-a')).toBe('');
    // A session that is deleted leaves no record and no keep-ref behind.
    expect(rig.records.size).toBe(0);
  });

  it('on a delete, keeps a person’s own branch', async () => {
    const theirs = rig.tree('feature/theirs');
    const result = await rig.service().remove(theirs.dir, deleting(theirs.session.id));
    expect(result).toMatchObject({ kind: 'removed', branch: 'kept' });
    expect(git(rig.clone, 'branch', '--list', 'feature/theirs')).toContain('feature/theirs');
  });

  it('keeps a branch that moved after it was checked', async () => {
    const mine = rig.tree('consola/session-a');
    const service = rig.service();
    // Moves the branch after the executor read HEAD but before it deletes.
    const original = rig.worktrees.deleteBranchAt.bind(rig.worktrees);
    vi.spyOn(rig.worktrees, 'deleteBranchAt').mockImplementation(async (repo, branch, head) => {
      git(rig.clone, 'branch', '-f', branch, 'main');
      return original(repo, branch, head);
    });
    const result = await service.remove(mine.dir, deleting(mine.session.id));
    expect(result).toMatchObject({ kind: 'removed', branch: 'kept' });
    expect(git(rig.clone, 'branch', '--list', 'consola/session-a')).toContain('consola/session-a');
  });
});

describe("a run's own checkout, removed (slice 3-B Task 19)", () => {
  const rigs: RunOwnedRig[] = [];
  afterAll(() => {
    for (const made of rigs) made.dispose();
  });
  async function rigged(): Promise<RunOwnedRig> {
    const made = await new RunOwnedRig().make();
    rigs.push(made);
    made.rules = {
      ...DEFAULT_WORKTREE_CLEANUP_RULES,
      runFinished: { enabled: true, afterMinutes: 60 },
    };
    return made;
  }
  const exists = (dir: string) => fs.existsSync(dir);
  const keptAt = (made: RunOwnedRig, ref = KEEP_REF) => {
    try {
      return made.git(made.source, 'rev-parse', '--verify', '-q', ref);
    } catch {
      return null;
    }
  };

  it("removes a clean, pushed one: the keep-ref in the person's clone, the session's and the run's record, both folders gone", async () => {
    const made = await rigged();
    made.push();
    const session = made.session();
    const result = await made.service().remove(made.dir, sweep());

    expect(result).toMatchObject({ kind: 'removed', branch: 'none' });
    expect(exists(made.dir)).toBe(false);
    expect(exists(made.gitDir)).toBe(false);
    expect(exists(`${made.gitDir}.consola.json`)).toBe(false);
    // In the person's clone (review S2), never in the run clone's git folder, which went with it.
    expect(keptAt(made)).toBe(made.head);
    expect(made.recorded).toEqual([
      {
        sessionId: session.id,
        removed: expect.objectContaining({
          kind: 'run-owned',
          runId: RUN_ID,
          path: made.dir,
          mainRepo: made.source,
          commit: made.head,
          branch: BRANCH,
          keepRef: KEEP_REF,
          trigger: 'run-finished',
        }),
      },
    ]);
    expect(made.runRecorded).toEqual([
      { runId: RUN_ID, removed: { commit: made.head, keepRef: KEEP_REF, at: expect.any(String) } },
    ]);
    expect(session.removedWorktree?.kind).toBe('run-owned');
  });

  it('a run of only run: steps, with no session, is recorded on the run and rebuilt for Retry from it (review S3)', async () => {
    const made = await rigged();
    made.push();
    const report = await made.service().sweep();

    expect(report.removed.map((entry) => entry.tree)).toEqual([made.dir]);
    expect(made.recorded).toEqual([]);
    expect(made.runRecorded[0]).toMatchObject({ runId: RUN_ID, removed: { commit: made.head } });
    const rebuilt = await made.rebuilder().restoreAt(made.dir);
    expect(rebuilt.rebuilt).toBe(true);
    expect(made.run('rev-parse', 'HEAD')).toBe(made.head);
    expect(made.runRecorded.at(-1)).toEqual({ runId: RUN_ID, removed: null });
  });

  it('a branch moved since Consola read its head removes nothing, and leaves an earlier keep-ref as it was (review S2)', async () => {
    const made = await rigged();
    made.push();
    // A keep-ref already there, as after a rebuild: what keeps that folder's commits (review NB2).
    made.git(made.source, 'update-ref', KEEP_REF, made.base0);
    const moving = Object.assign(Object.create(made.worktrees), {
      // The slow checks run after the head was read and before the keep-ref is fetched.
      nestedRepos: async (tree: string) => {
        made.run('update-ref', `refs/heads/${BRANCH}`, made.base0);
        return made.worktrees.nestedRepos(tree);
      },
    }) as WorktreeService;
    const result = await made.service({ worktrees: moving }).remove(made.dir, sweep());

    expect(result).toEqual({
      kind: 'failed',
      error: "the run's branch is not at the commit Consola recorded; nothing was removed",
    });
    expect(exists(made.dir)).toBe(true);
    expect(exists(made.gitDir)).toBe(true);
    expect(keptAt(made)).toBe(made.base0);
    expect(made.recorded).toEqual([]);
    expect(made.runRecorded).toEqual([]);
  });

  it('a forged remote-tracking ref loses nothing: the keep-ref holds the commit', async () => {
    const made = await rigged();
    // Published as far as the clone can tell, never pushed: a step can write its own remote-tracking refs (A2).
    made.run('update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD');
    expect(() => made.git(made.remote, 'rev-parse', '--verify', '-q', BRANCH)).toThrow();
    made.session();
    const result = await made.service().remove(made.dir, sweep());

    expect(result).toMatchObject({ kind: 'removed' });
    expect(keptAt(made)).toBe(made.head);
    const rebuilt = await made
      .rebuilder()
      .ensureCheckout(made.workspace, made.workspace.sessions[0]);
    expect(rebuilt.rebuilt).toBe(true);
    expect(made.run('rev-parse', 'HEAD')).toBe(made.head);
    expect(fs.readFileSync(path.join(made.dir, 'fix.txt'), 'utf8')).toBe('fixed\n');
  });

  it("a folder in the person's clone, or one whose config names another run, is never removed through this path", async () => {
    const made = await rigged();
    const own = (await made.worktrees.inspect(made.dir))!;
    const clone = (await made.worktrees.inspect(made.source))!;
    // A copy under a name that is not its run's, its git folder saying the run.
    const misnamed = path.join(made.root, 'catalog-portal-run-aaaaaaaa');
    fs.cpSync(made.dir, misnamed, { recursive: true });
    fs.cpSync(made.gitDir, runCloneGitDirFor(misnamed), { recursive: true });
    for (const inspection of [
      clone,
      { ...own, toplevel: made.source },
      { ...clone, runOwned: { runId: RUN_ID } },
      { ...own, runOwned: { runId: '99999999aaaa' } },
      { ...own, toplevel: misnamed },
    ]) {
      await expect(made.worktrees.removeRunClone(inspection)).rejects.toThrow(
        `Refusing to remove ${inspection.toplevel}: it is not a run's own checkout.`,
      );
    }
    made.git(
      made.base,
      'config',
      '--file',
      path.join(made.gitDir, 'config'),
      'consola.run',
      '3f2a91c0ffff',
    );
    await expect(made.worktrees.removeRunClone(own)).rejects.toThrow(
      "it is not a run's own checkout",
    );
    expect(exists(made.source)).toBe(true);
    expect(exists(made.dir)).toBe(true);
    expect(exists(made.gitDir)).toBe(true);
    expect(exists(misnamed)).toBe(true);
  });

  it('a removal refused before anything went clears both records and keeps the folder and its keep-ref', async () => {
    const made = await rigged();
    made.push();
    const session = made.session();
    const refusing = Object.assign(Object.create(made.worktrees), {
      removeRunClone: async () => {
        throw new Error('EBUSY: resource busy');
      },
    }) as WorktreeService;
    const result = await made.service({ worktrees: refusing }).remove(made.dir, sweep());

    expect(result).toEqual({ kind: 'failed', error: 'EBUSY: resource busy' });
    expect(session.removedWorktree).toBeUndefined();
    expect(made.runRecorded.at(-1)).toEqual({ runId: RUN_ID, removed: null });
    expect(exists(made.dir)).toBe(true);
    expect(keptAt(made)).toBe(made.head);
  });
});
