import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, Workspace } from '../../shared/workspace';
import { DEFAULT_WORKTREE_CLEANUP_RULES, keepRefFor } from '../../shared/worktreeCleanup';
import type { RemovedWorktree } from '../../shared/worktreeCleanup';
import type { GitProviderDriver } from '../providers/GitProviderDriver';
import { WorktreeService } from '../WorktreeService';
import { PathLock } from './PathLock';
import { BRANCH, KEEP_REF, RUN_ID, RunOwnedRig } from './runOwned.test-helpers';
import { WorktreeRebuilder } from './WorktreeRebuilder';

/**
 * Putting a removed worktree back, against real git: at its path, on its
 * commit, never at whatever its branch or pull request says now.
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

function commit(cwd: string, file: string): string {
  fs.writeFileSync(path.join(cwd, file), file);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

class Rig {
  readonly base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-rebuild-')));
  readonly clone = path.join(this.base, 'app');
  readonly root = path.join(this.base, 'worktrees');
  readonly checkouts: string[] = [];
  readonly driver = {
    checkout: async (dir: string) => {
      this.checkouts.push(dir);
    },
  } as unknown as GitProviderDriver;
  readonly worktrees = new WorktreeService(this.root, () => this.driver, new PathLock());
  readonly lock = new PathLock();
  readonly workspace: Workspace;

  constructor() {
    created.push(this.base);
    fs.mkdirSync(this.root);
    execFileSync('git', ['init', '-q', '-b', 'main', this.clone]);
    commit(this.clone, 'README');
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

  /**
   * A worktree on `branch` with one commit, removed the way the executor
   * removes one: keep-ref, record, `git worktree remove`.
   */
  removed(name: string, branch: string | null): { session: Session; record: RemovedWorktree } {
    const dir = path.join(this.root, name);
    git(this.clone, 'worktree', 'add', '-q', ...(branch ? ['-b', branch] : ['--detach']), dir);
    const head = commit(dir, `${name}.txt`);
    const record: RemovedWorktree = {
      path: dir,
      mainRepo: this.clone,
      commit: head,
      branch,
      keepRef: keepRefFor(dir),
      trigger: 'settled',
      removedAt: 0,
    };
    git(this.clone, 'update-ref', record.keepRef, head);
    git(this.clone, 'worktree', 'remove', dir);
    const session: Session = {
      id: `s-${name}`,
      name,
      workspaceId: 'ws',
      instanceId: `i-${name}`,
      claudeSessionId: `c-${name}`,
      hasStarted: true,
      harnessId: 'claude',
      scopeId: 'scope',
      kind: 'interactive',
      cwd: dir,
      removedWorktree: record,
      createdAt: 0,
      lastActiveAt: 0,
    };
    this.workspace.sessions.push(session);
    return { session, record };
  }

  rebuilder(): WorktreeRebuilder {
    const rebuilder = new WorktreeRebuilder({
      lock: this.lock,
      getWorkspaces: () => [this.workspace],
      worktrees: this.worktrees,
      clearRemoved: (worktreePath) => {
        for (const session of this.workspace.sessions) {
          if (session.removedWorktree?.path === worktreePath) delete session.removedWorktree;
        }
      },
    });
    this.worktrees.restoreRemoved = (dir) => rebuilder.restoreAt(dir);
    return rebuilder;
  }

  keepRefExists(ref: string): boolean {
    try {
      git(this.clone, 'rev-parse', '--verify', '-q', ref);
      return true;
    } catch {
      return false;
    }
  }
}

let rig: Rig;
beforeEach(() => {
  rig = new Rig();
});

describe('WorktreeRebuilder', () => {
  it('rebuilds at the same path, on the branch when it has not moved, and says so', async () => {
    const { session, record } = rig.removed('app-session-1', 'consola/session-a');
    const result = await rig.rebuilder().ensureCheckout(rig.workspace, session);

    expect(result).toEqual({
      rebuilt: true,
      notice: `Consola rebuilt this session's worktree on consola/session-a at ${record.commit.slice(0, 7)}. Dependencies and build output were not restored.`,
    });
    expect(git(record.path, 'rev-parse', 'HEAD')).toBe(record.commit);
    expect(git(record.path, 'symbolic-ref', '--short', 'HEAD')).toBe('consola/session-a');
    expect(session.removedWorktree).toBeUndefined();
    expect(rig.keepRefExists(record.keepRef)).toBe(false);
  });

  it('stays detached on the recorded commit when the branch moved since', async () => {
    const { session, record } = rig.removed('app-session-1', 'consola/session-a');
    git(rig.clone, 'branch', '-f', 'consola/session-a', 'main');
    const result = await rig.rebuilder().ensureCheckout(rig.workspace, session);

    expect(result.notice).toMatch(/detached: consola\/session-a has moved since/);
    expect(git(record.path, 'rev-parse', 'HEAD')).toBe(record.commit);
    expect(() => git(record.path, 'symbolic-ref', '-q', 'HEAD')).toThrow();
  });

  it('restores a commit only the keep-ref still holds', async () => {
    const { session, record } = rig.removed('app-pr-7', 'feature');
    // The author force-pushed and a later checkout reset the branch: only
    // the keep-ref still points at the commit the session was working on.
    git(rig.clone, 'branch', '-f', 'feature', 'main');
    git(rig.clone, 'reflog', 'expire', '--expire=now', '--all');
    git(rig.clone, 'gc', '-q', '--prune=now');
    expect(git(rig.clone, 'cat-file', '-t', record.commit)).toBe('commit');

    await rig.rebuilder().ensureCheckout(rig.workspace, session);
    expect(git(record.path, 'rev-parse', 'HEAD')).toBe(record.commit);
  });

  it('leaves a folder that came back on its own as it is, and says what it found', async () => {
    const { session, record } = rig.removed('app-session-1', 'consola/session-a');
    // A removal interrupted after the record but before git ran.
    git(rig.clone, 'worktree', 'add', '-q', '--detach', record.path, 'main');
    const main = git(rig.clone, 'rev-parse', 'main');
    const result = await rig.rebuilder().ensureCheckout(rig.workspace, session);

    expect(result.rebuilt).toBe(false);
    expect(result.notice).toMatch(`found at ${main.slice(0, 7)}, not ${record.commit.slice(0, 7)}`);
    expect(git(record.path, 'rev-parse', 'HEAD')).toBe(main);
    expect(session.removedWorktree).toBeUndefined();
  });

  it('refuses a folder that is not this clone’s worktree, keeping the record', async () => {
    const { session, record } = rig.removed('app-session-1', 'consola/session-a');
    fs.mkdirSync(record.path);
    fs.writeFileSync(path.join(record.path, 'someone-elses.txt'), 'x');

    await expect(rig.rebuilder().ensureCheckout(rig.workspace, session)).rejects.toThrow(
      /exists but is not a git worktree/,
    );
    expect(session.removedWorktree).toEqual(record);
    expect(fs.existsSync(path.join(record.path, 'someone-elses.txt'))).toBe(true);
  });

  it('keeps the record when the commit is gone, with a clear sentence', async () => {
    const { session, record } = rig.removed('app-session-1', null);
    git(rig.clone, 'update-ref', '-d', record.keepRef);
    git(rig.clone, 'reflog', 'expire', '--expire=now', '--all');
    git(rig.clone, 'gc', '-q', '--prune=now');

    await expect(rig.rebuilder().ensureCheckout(rig.workspace, session)).rejects.toThrow(
      `the commit it was on (${record.commit.slice(0, 7)}) is no longer in`,
    );
    expect(session.removedWorktree).toEqual(record);
  });

  it('runs no git hooks', async () => {
    const hooks = path.join(rig.base, 'hooks');
    fs.mkdirSync(hooks);
    const marker = path.join(rig.base, 'hook-ran');
    fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\ntouch "${marker}"\n`, {
      mode: 0o755,
    });
    const { session } = rig.removed('app-session-1', 'consola/session-a');
    git(rig.clone, 'config', 'core.hooksPath', hooks);
    // The hook is live: a plain worktree add runs it.
    git(rig.clone, 'worktree', 'add', '-q', '--detach', path.join(rig.base, 'probe'), 'main');
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);

    await rig.rebuilder().ensureCheckout(rig.workspace, session);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('is what an Inbox click lands on: ensureWorktree hands the folder over, no provider checkout', async () => {
    const { record } = rig.removed('app-pr-7', 'feature');
    commit(rig.clone, 'newer-upstream.txt');
    rig.rebuilder();

    const dir = await rig.worktrees.ensureWorktree(
      rig.clone,
      { provider: 'github', repo: 'acme/app', type: 'pr', number: 7 },
      process.env,
    );

    expect(dir).toBe(record.path);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(record.commit);
    expect(rig.checkouts).toEqual([]);
    expect(rig.workspace.sessions[0].removedWorktree).toBeUndefined();
  });

  it('serialises with anything else on the folder: two opens rebuild once', async () => {
    const { session, record } = rig.removed('app-session-1', 'consola/session-a');
    const rebuilder = rig.rebuilder();
    const copy = { ...session };
    const [first, second] = await Promise.all([
      rebuilder.ensureCheckout(rig.workspace, session),
      rebuilder.ensureCheckout(rig.workspace, copy),
    ]);
    expect([first.rebuilt, second.rebuilt].sort()).toEqual([false, true]);
    expect(git(record.path, 'rev-parse', 'HEAD')).toBe(record.commit);
  });
});

describe("a run's own checkout, rebuilt (slice 3-B Task 19)", () => {
  const rigs: RunOwnedRig[] = [];
  afterAll(() => {
    for (const made of rigs) made.dispose();
  });
  const SWEEP = {
    request: { trigger: 'sweep' as const, targets: new Set<string>(), now: Date.now() },
  };

  async function removed(): Promise<{ made: RunOwnedRig; session: Session }> {
    const made = await new RunOwnedRig().make();
    rigs.push(made);
    made.rules = {
      ...DEFAULT_WORKTREE_CLEANUP_RULES,
      runFinished: { enabled: true, afterMinutes: 60 },
    };
    made.push();
    const session = made.session();
    expect(await made.service().remove(made.dir, SWEEP)).toMatchObject({ kind: 'removed' });
    return { made, session };
  }

  it("rebuilds it at the recorded commit on its branch, both folders and the pointer, and keeps the keep-ref: a gc in the person's clone leaves it whole (review NB2)", async () => {
    const { made, session } = await removed();
    // After the removal the run's commit is in the person's clone only through the keep-ref,
    // and the rebuilt clone borrows its objects from there.
    expect(() => made.git(made.source, 'cat-file', '-e', made.head)).not.toThrow();
    const rebuilt = await made.rebuilder().ensureCheckout(made.workspace, session);

    expect(rebuilt).toEqual({
      rebuilt: true,
      notice: `Consola rebuilt this run's checkout on ${BRANCH} at ${made.head.slice(0, 7)}. Dependencies and build output were not restored.`,
    });
    expect(made.run('rev-parse', 'HEAD')).toBe(made.head);
    expect(made.run('symbolic-ref', 'HEAD')).toBe(`refs/heads/${BRANCH}`);
    expect(fs.readFileSync(path.join(made.dir, '.git'), 'utf8')).toBe(`gitdir: ${made.gitDir}\n`);
    expect(
      made.git(made.base, 'config', '--file', path.join(made.gitDir, 'config'), 'consola.run'),
    ).toBe(RUN_ID);
    expect(session.removedWorktree).toBeUndefined();
    expect(made.runRecorded.at(-1)).toEqual({ runId: RUN_ID, removed: null });
    // Kept, with the folder.
    expect(made.git(made.source, 'rev-parse', '--verify', KEEP_REF)).toBe(made.head);
    made.git(made.source, 'reflog', 'expire', '--expire=now', '--all');
    made.git(made.source, 'gc', '-q', '--prune=now');
    // The re-check saw `fatal: bad object HEAD` here once the keep-ref went.
    expect(() => made.run('cat-file', '-e', made.head)).not.toThrow();
    expect(made.run('status', '--porcelain')).toBe('');
  });

  it('removes it again after a rebuild, its keep-ref rewritten under the same name', async () => {
    const { made, session } = await removed();
    await made.rebuilder().ensureCheckout(made.workspace, session);
    fs.writeFileSync(path.join(made.dir, 'more.txt'), 'more\n');
    made.run('add', '-A');
    made.run('commit', '-q', '-m', 'more');
    made.push();
    const next = made.run('rev-parse', 'HEAD');
    session.lastActiveAt = Date.now() - 5 * 24 * 60 * 60_000;
    expect(await made.service().remove(made.dir, SWEEP)).toMatchObject({ kind: 'removed' });
    expect(made.git(made.source, 'rev-parse', '--verify', KEEP_REF)).toBe(next);
    expect(fs.existsSync(made.dir)).toBe(false);
  });

  it('a rebuild whose commit is gone from the person’s clone fails in words, keeps the record and makes no folder', async () => {
    const { made, session } = await removed();
    made.git(made.source, 'update-ref', '-d', KEEP_REF);
    made.git(made.source, 'reflog', 'expire', '--expire=now', '--all');
    made.git(made.source, 'gc', '-q', '--prune=now');
    await expect(made.rebuilder().ensureCheckout(made.workspace, session)).rejects.toThrow(
      "Consola could not rebuild this run's checkout:",
    );
    expect(session.removedWorktree?.kind).toBe('run-owned');
    expect(fs.existsSync(made.dir)).toBe(false);
    expect(fs.existsSync(made.gitDir)).toBe(false);
  });
});
