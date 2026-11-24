import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deleteRunClone,
  fetchKeepRef,
  runCloneGitDirFor,
  RunCheckoutError,
} from '@consola/automation-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../shared/workspace';
import type { RemovedWorktree } from '../../shared/worktreeCleanup';
import { WorktreeService } from '../WorktreeService';
import { PathLock } from '../worktreeCleanup/PathLock';
import { ProcessCwdIndex } from '../worktreeCleanup/ProcessCwdIndex';
import { WorktreeRebuilder } from '../worktreeCleanup/WorktreeRebuilder';
import { runCheckoutSpawnRefusal, runOwnedCheckoutPort } from './runOwnedCheckout';
import type { RunOwnedCheckoutDeps } from './runOwnedCheckout';

/*
 * The desktop's half of a run's own checkout (slice 3-B Task 18), against
 * real git in a temp folder and real processes it starts itself. Nothing
 * here signals or writes anything outside its own temp folder.
 */

let tmp: string;
let root: string;
let source: string;
let dir: string;
const children: ChildProcess[] = [];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();

const WORKSPACE = {
  id: 'ws-1',
  scopes: [{ id: 'scope-1', name: 'catalog-portal', path: '' }],
  sessions: [],
} as unknown as Workspace;

/** Never a real signal: `ESRCH` for a liveness probe, a record for the rest. */
function noSignals(): RunOwnedCheckoutDeps['kill'] & { mock: { calls: unknown[][] } } {
  return vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
    if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  }) as never;
}

function deps(over: Partial<RunOwnedCheckoutDeps> = {}): RunOwnedCheckoutDeps {
  return {
    root,
    getWorkspace: (id) => (id === WORKSPACE.id ? WORKSPACE : undefined),
    resolveRepo: (_workspace, repo) => (repo === 'sprocket/catalog-portal' ? source : null),
    fetchEnv: async () => ({ ...process.env }),
    scopeIdForPath: () => 'scope-1',
    processes: new ProcessCwdIndex(),
    stepProcesses: () => null,
    identify: () => null,
    liveTerminals: () => ({ agents: [], shells: [] }),
    sessions: () => [],
    kill: noSignals(),
    graceMs: 300,
    restoreAt: async () => ({ rebuilt: false }),
    underLock: (_dir, work) => work(),
    ...over,
  };
}

/** A process of its own, in its own group, working in `cwd`. */
function start(command: string, args: string[], cwd: string): ChildProcess {
  const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' });
  children.push(child);
  return child;
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-run-owned-')));
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(tmp, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  const remote = path.join(tmp, 'remote.git');
  source = path.join(tmp, 'catalog-portal');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  git(tmp, 'clone', '-q', remote, source);
  git(source, 'config', 'user.name', 'alice');
  git(source, 'config', 'user.email', 'alice@sprocket.example');
  fs.writeFileSync(path.join(source, 'README.md'), 'catalog-portal\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'first');
  git(source, 'push', '-q', 'origin', 'HEAD:main');
  root = path.join(tmp, 'worktrees');
  const made = await runOwnedCheckoutPort(deps()).make({
    workspaceId: 'ws-1',
    runId: '3f2a91c0aabbccdd',
    automation: 'fix',
    repo: 'sprocket/catalog-portal',
    branch: 'fix/SHOP-42',
  });
  dir = made.cwd;
});

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the desktop’s run-owned checkout port (slice 3-B Task 18)', () => {
  it('makes it from the person’s clone under the worktree root, named for its run', () => {
    expect(dir).toBe(path.join(root, 'catalog-portal-run-3f2a91c0'));
    expect(fs.readFileSync(path.join(dir, '.git'), 'utf8')).toBe(
      `gitdir: ${runCloneGitDirFor(dir)}\n`,
    );
    expect(
      runOwnedCheckoutPort(deps()).pathFor('3f2a91c0aabbccdd', 'sprocket/catalog-portal'),
    ).toBe(dir);
  });

  it("makes a half-made checkout again only when the run's record vouches for it, under the folder's lock (3-B code review F10)", async () => {
    // A quit before the identity: the git folder does not name the run yet.
    git(
      tmp,
      'config',
      '--file',
      path.join(runCloneGitDirFor(dir), 'config'),
      '--remove-section',
      'consola',
    );
    const locked: string[] = [];
    const port = runOwnedCheckoutPort(
      deps({
        underLock: (at, work) => {
          locked.push(at);
          return work();
        },
      }),
    );
    const request = {
      workspaceId: 'ws-1',
      runId: '3f2a91c0aabbccdd',
      automation: 'fix',
      repo: 'sprocket/catalog-portal',
      branch: 'fix/SHOP-42',
    };
    await expect(port.make(request)).rejects.toMatchObject({ stage: 'clone' });
    const made = await port.make({ ...request, again: true });
    expect(made.cwd).toBe(dir);
    expect(
      git(tmp, 'config', '--file', path.join(runCloneGitDirFor(dir), 'config'), 'consola.run'),
    ).toBe('3f2a91c0aabbccdd');
    expect(locked).toEqual([dir, dir]);
  });

  it("refuses to make a checkout of a repository no scope holds, in slice 1's words", async () => {
    const made = runOwnedCheckoutPort(deps()).make({
      workspaceId: 'ws-1',
      runId: '99999999aaaa',
      automation: 'fix',
      repo: 'sprocket/storefront',
      branch: 'fix/1',
    });
    await expect(made).rejects.toBeInstanceOf(RunCheckoutError);
    await expect(made).rejects.toMatchObject({
      stage: 'resolve',
      message: expect.stringContaining(
        'Clone sprocket/storefront into one of this workspace’s scopes',
      ),
    });
    expect(fs.existsSync(path.join(root, 'storefront-run-99999999'))).toBe(false);
  });

  it("ends the step's own group and recorded descendants, and says when one survives", async () => {
    const step = start('sleep', ['30'], dir);
    const live = deps({
      kill: (pid, signal) => process.kill(pid, signal),
      stepProcesses: () => ({ pgid: step.pid!, descendants: [] }),
    });
    expect(await runOwnedCheckoutPort(live).endStepProcesses({ dir, sessionId: 's-fix' })).toEqual({
      kind: 'clear',
    });
    expect(() => process.kill(-step.pid!, 0)).toThrow();
    // A kill that never kills: the group is still there after SIGKILL.
    const stubborn = start('sleep', ['30'], dir);
    const never = deps({
      kill: (pid, signal) => {
        if (signal === 0) process.kill(pid, 0);
      },
      stepProcesses: () => ({ pgid: stubborn.pid!, descendants: [] }),
    });
    expect(await runOwnedCheckoutPort(never).endStepProcesses({ dir, sessionId: 's-fix' })).toEqual(
      {
        kind: 'survivors',
        count: 1,
      },
    );
  });

  it('asks the step’s group to end first, and kills what ignores that once its grace is over', async () => {
    const live = (pgid: number) =>
      deps({
        kill: (pid, signal) => process.kill(pid, signal),
        stepProcesses: () => ({ pgid, descendants: [] }),
      });
    // A process that ends on SIGTERM, saying so: it was asked, not killed. The
    // marker's path reaches the script as its `$1`, never as part of its text.
    const marker = path.join(tmp, 'asked.txt');
    const polite = start(
      'sh',
      ['-c', 'trap \'echo asked > "$1"; exit 0\' TERM; while :; do sleep 0.1; done', 'sh', marker],
      dir,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      await runOwnedCheckoutPort(live(polite.pid!)).endStepProcesses({ dir, sessionId: 's' }),
    ).toEqual({
      kind: 'clear',
    });
    expect(fs.existsSync(marker)).toBe(true);
    // One that ignores SIGTERM is killed after the grace.
    const deaf = start('sh', ['-c', "trap '' TERM; while :; do sleep 0.1; done"], dir);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      await runOwnedCheckoutPort(live(deaf.pid!)).endStepProcesses({ dir, sessionId: 's' }),
    ).toEqual({
      kind: 'clear',
    });
    expect(() => process.kill(-deaf.pid!, 0)).toThrow();
  });

  it("never signals a person's process in the checkout: a Consola session there is excluded, anything else is a stranger (review B6)", async () => {
    const theirs = start('sleep', ['30'], dir);
    const kill = noSignals();
    const port = runOwnedCheckoutPort(
      deps({ kill, stepProcesses: () => ({ pgid: 999_999, descendants: [] }) }),
    );
    expect(await port.endStepProcesses({ dir, sessionId: 's-fix' })).toEqual({
      kind: 'strangers',
      processes: [{ pid: theirs.pid, command: 'sleep' }],
    });
    expect(kill.mock.calls.some(([pid]) => pid === theirs.pid || pid === -theirs.pid!)).toBe(false);
    const asSession = runOwnedCheckoutPort(
      deps({ kill, liveTerminals: () => ({ agents: [theirs.pid!], shells: [] }) }),
    );
    expect(await asSession.endStepProcesses({ dir, sessionId: 's-fix' })).toEqual({
      kind: 'clear',
    });
  });

  it("a process started from a Consola shell in the checkout is a stranger: the shell is excluded alone, as FactGatherer excludes it (the re-check's Minor)", async () => {
    const shell = start('sh', ['-c', 'sleep 30; :'], dir);
    await vi.waitFor(() =>
      expect(
        execFileSync('pgrep', ['-P', String(shell.pid)], { encoding: 'utf8' }).trim(),
      ).not.toBe(''),
    );
    const port = runOwnedCheckoutPort(
      deps({ liveTerminals: () => ({ agents: [], shells: [shell.pid!] }) }),
    );
    expect(await port.endStepProcesses({ dir, sessionId: 's-fix' })).toMatchObject({
      kind: 'strangers',
      processes: [expect.objectContaining({ command: 'sleep' })],
    });
  });

  it('a recorded descendant whose pid now names another process is left alone: its start time differs (the re-check’s Minor)', async () => {
    const kill = noSignals();
    const port = runOwnedCheckoutPort(
      deps({
        kill,
        stepProcesses: () => ({
          pgid: 999_999,
          descendants: [{ pid: 4242, pgid: 999_999, started: 'Sun Nov 22 10:00:00 2026' }],
        }),
        identify: (pid) =>
          pid === 4242 ? { pgid: 4242, started: 'Sun Nov 22 11:30:00 2026' } : null,
      }),
    );
    await port.endStepProcesses({ dir, sessionId: 's-fix' });
    expect(kill.mock.calls.some(([pid]) => pid === 4242)).toBe(false);
  });

  it('answers folderProblem from gitFolderProblem (review NB1)', () => {
    const port = runOwnedCheckoutPort(deps());
    expect(port.folderProblem(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(source, '.git')}\n`);
    expect(port.folderProblem(dir)).toBe(".git in the checkout is not Consola's pointer");
  });

  it('holds a folder for the first session whose CLI runs there, by cwd or agentCwd', () => {
    const sessions = [
      { id: 's-old', name: 'old', cwd: dir, running: false },
      { id: 's-fix', name: 'fix', agentCwd: dir, running: true },
    ];
    expect(runOwnedCheckoutPort(deps({ sessions: () => sessions })).holder(dir)).toEqual({
      sessionId: 's-fix',
      name: 'fix',
    });
    expect(runOwnedCheckoutPort(deps({ sessions: () => [sessions[0]] })).holder(dir)).toBeNull();
  });

  it('names a session launched in the folder with full tools, running or not, and never one with a policy (3-B code review F7)', () => {
    const sessions = [
      { id: 's-fix', name: 'fix', cwd: dir, running: false, toolPolicy: 'write' as const },
      { id: 's-elsewhere', name: 'other', cwd: source, running: true },
      { id: 's-moved', name: 'moved in', agentCwd: dir, running: true },
      { id: 's-fork', name: 'fix (full tools)', cwd: `${dir}/`, running: false },
    ];
    expect(runOwnedCheckoutPort(deps({ sessions: () => sessions })).fullToolsSession(dir)).toEqual({
      sessionId: 's-fork',
      name: 'fix (full tools)',
    });
    expect(
      runOwnedCheckoutPort(deps({ sessions: () => sessions.slice(0, 3) })).fullToolsSession(dir),
    ).toBeNull();
  });

  it('never settles past a holder or a live process: a step’s settle and a boundary each refuse first, committing nothing', async () => {
    fs.writeFileSync(path.join(dir, 'fix.txt'), 'fixed\n');
    fs.mkdirSync(path.join(tmp, 'attempt'));
    const base = git(dir, 'rev-parse', 'HEAD');
    const settle = {
      dir,
      branch: 'fix/SHOP-42',
      base,
      before: base,
      step: 'fix',
      commit: { message: 'fix (attempt 1) of fix on 3f2a91c0' },
      attemptDir: path.join(tmp, 'attempt'),
    };
    const between = {
      dir,
      branch: 'fix/SHOP-42',
      base,
      before: base,
      message: 'changes by fix during fix',
      session: 'fix',
    };
    const held = runOwnedCheckoutPort(
      deps({ sessions: () => [{ id: 's-fix', name: 'fix', cwd: dir, running: true }] }),
    );
    const words = "`fix` is open in this run's checkout; close it, then retry";
    expect(await held.settle(settle)).toEqual({ ok: false, error: words });
    expect(await held.settleBetween(between)).toEqual({ ok: false, error: words });
    const left = start('sleep', ['30'], dir);
    const port = runOwnedCheckoutPort(deps());
    expect(await port.settleBetween(between)).toEqual({
      ok: false,
      error: "`fix`, opened by you, left a process running in this run's checkout",
    });
    expect(await port.settle(settle)).toEqual({
      ok: false,
      error: `a process outside Consola's sessions is running in this run's checkout (sleep, pid ${left.pid}); end it, then retry`,
    });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(base);
    process.kill(-left.pid!, 'SIGKILL');
    await vi.waitFor(async () => expect((await port.settle(settle)).ok).toBe(true), {
      timeout: 5_000,
    });
  });
});

describe('a session or shell in a run’s own checkout (slice 3-B Task 18, review NB1)', () => {
  it('starts nothing where the pointer was rewritten, and anything where it is as Consola wrote it', () => {
    expect(runCheckoutSpawnRefusal({ cwd: dir }, root)).toBeNull();
    expect(runCheckoutSpawnRefusal({ cwd: source, agentCwd: dir }, root)).toBeNull();
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(source, '.git')}\n`);
    const words =
      "the git folder of this run's checkout changed (.git in the checkout is not Consola's pointer), so Consola will not start anything in it";
    expect(runCheckoutSpawnRefusal({ cwd: dir }, root)).toBe(words);
    expect(runCheckoutSpawnRefusal({ cwd: source, agentCwd: dir }, root)).toBe(words);
    // Not a run's own checkout: a scope, or a folder under the root with no run clone's git folder.
    expect(runCheckoutSpawnRefusal({ cwd: source }, root)).toBeNull();
    fs.mkdirSync(path.join(root, 'catalog-portal-pr-7'));
    expect(
      runCheckoutSpawnRefusal({ cwd: path.join(root, 'catalog-portal-pr-7') }, root),
    ).toBeNull();
  });
});

describe("a run's own checkout that cleanup removed, rebuilt for a Retry (slice 3-B Task 19)", () => {
  it('comes back at the commit its run recorded, from the person’s clone, and the record is cleared', async () => {
    fs.writeFileSync(path.join(dir, 'fix.txt'), 'fixed\n');
    git(dir, 'add', '-A');
    git(
      dir,
      '-c',
      'user.name=alice',
      '-c',
      'user.email=alice@sprocket.example',
      'commit',
      '-q',
      '-m',
      'fix',
    );
    const head = git(dir, 'rev-parse', 'HEAD');
    const keepRef = 'refs/consola/worktrees/catalog-portal-run-3f2a91c0';
    await fetchKeepRef({ source, dir, branch: 'fix/SHOP-42', head, keepRef });
    deleteRunClone(dir);
    // The run's record of the removal, as main reads it from history (no session names it).
    let record: RemovedWorktree | undefined = {
      path: dir,
      mainRepo: source,
      commit: head,
      branch: 'fix/SHOP-42',
      keepRef,
      trigger: 'run-finished',
      removedAt: 0,
      kind: 'run-owned',
      runId: '3f2a91c0aabbccdd',
    };
    const cleared = vi.fn((_runId: string) => {
      record = undefined;
    });
    const rebuilder = new WorktreeRebuilder({
      lock: new PathLock(),
      getWorkspaces: () => [],
      worktrees: new WorktreeService(root),
      clearRemoved: () => {},
      runRecordAt: (at) => (at === dir ? record : undefined),
      clearRunRecord: cleared,
    });
    const restoreAt = vi.fn((at: string) => rebuilder.restoreAt(at));
    const locked: string[] = [];
    const port = runOwnedCheckoutPort(
      deps({
        restoreAt,
        underLock: (at, work) => {
          locked.push(at);
          return work();
        },
      }),
    );
    await port.restore(dir);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(fs.readFileSync(path.join(dir, 'fix.txt'), 'utf8')).toBe('fixed\n');
    expect(port.folderProblem(dir)).toBeNull();
    expect(cleared).toHaveBeenCalledWith('3f2a91c0aabbccdd');
    expect(locked).toEqual([dir]);
    // The keep-ref stays while the rebuilt folder exists (review NB2).
    expect(git(source, 'rev-parse', keepRef)).toBe(head);
    // A folder that is there is left alone.
    await port.restore(dir);
    expect(restoreAt).toHaveBeenCalledTimes(1);
    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it('a folder that is gone with no record of its removal is refused, never made anew', async () => {
    deleteRunClone(dir);
    await expect(runOwnedCheckoutPort(deps()).restore(dir)).rejects.toThrow(
      'is gone and nothing records how to rebuild it, so Consola will not make it anew',
    );
    expect(fs.existsSync(dir)).toBe(false);
  });
});
