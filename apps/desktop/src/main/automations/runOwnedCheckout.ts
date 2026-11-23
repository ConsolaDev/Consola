import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  folderChangedMessage,
  gitFolderProblem,
  makeRunClone,
  RunCheckoutError,
  resetRunClone,
  runCloneChanges,
  runCloneGitDirFor,
  runCloneShowAt,
  runOwnedDirName,
  sessionHoldsRetry,
  settleBetweenSteps,
  settleRunClone,
  type RunCheckoutPort,
  type SettleResult,
  type StepProcesses,
} from '@consola/automation-engine';
import type { Session, Workspace } from '../../shared/workspace';
import { ProcessCwdIndex, type ProcessSnapshot } from '../worktreeCleanup/ProcessCwdIndex';
import { launchedWithFullTools } from './launchAgentRun';

/** What the desktop's run-owned checkout port is built from (slice 3-B Task 18, Calls 1, 8, 12). */
export interface RunOwnedCheckoutDeps {
  /** The worktree root: every run's checkout is a direct child of it. */
  root: string;
  getWorkspace(id: string): Workspace | undefined;
  /** The person's clone of `repo` (`owner/name`) in one of the workspace's scopes, or null. */
  resolveRepo(workspace: Workspace, repo: string): string | null;
  /** The environment the one fetch from the real remote runs with: the bound account's, else the login one. */
  fetchEnv(workspace: Workspace): Promise<NodeJS.ProcessEnv>;
  scopeIdForPath(workspace: Workspace, clonePath: string): string;
  processes: Pick<ProcessCwdIndex, 'snapshot'>;
  /** A write step's session's CLI group and the descendants recorded at its turn's end. */
  stepProcesses(sessionId: string): {
    pgid: number;
    descendants: Array<{ pid: number; pgid: number; started: string }>;
  } | null;
  /** One `ps -o pgid=,lstart= -p <pid>`: the process's group and start time, null when it is gone. */
  identify(pid: number): { pgid: number; started: string } | null;
  /** Every live Consola terminal: agent CLIs (excluded with their descendants) and shells (excluded alone). */
  liveTerminals(): { agents: number[]; shells: number[] };
  /** Every session of every workspace, with whether its CLI is running and its tool policy (absent: full tools). */
  sessions(): Array<{
    id: string;
    name: string;
    cwd?: string;
    agentCwd?: string;
    running: boolean;
    toolPolicy?: Session['toolPolicy'];
  }>;
  /** `process.kill`: a negative pid is a group. Throws `ESRCH` for one that is gone. */
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  /** How long a step's processes get after SIGTERM before SIGKILL; absent, 2 s. For tests. */
  graceMs?: number;
  /**
   * Task 19: a removed run's checkout at `dir` put back from what records
   * its removal, the sessions' record or else the run's, at the commit it
   * recorded, both records cleared and the keep-ref kept
   * (`WorktreeRebuilder.restoreAt`, called with the folder's lock held).
   * `rebuilt: false` when nothing records a removal there.
   */
  restoreAt(dir: string): Promise<{ rebuilt: boolean }>;
  /** The folder's lock, which removal, rebuild and making all take (`PathLock.run`). */
  underLock<T>(dir: string, work: () => Promise<T>): Promise<T>;
}

/** How long a step's own processes get to end after SIGTERM (Call 8). */
export const STEP_PROCESS_GRACE_MS = 2_000;

/** Words for a run whose repository is not cloned here (slice 1's, for a repository rather than an item). */
export function notClonedMessage(repo: string): string {
  return `Clone ${repo} into one of this workspace’s scopes so this automation can make its own checkout of it.`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether a signal reached something: `ESRCH` is nothing there; any other error is something we may not signal. */
function signalled(deps: RunOwnedCheckoutDeps, pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    deps.kill(pid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * The run-owned checkout, the desktop's half (plan Call 1): the git work is
 * the engine's adapter; what only the desktop has is the person's clone and
 * account, the step's own processes, and the sessions in a folder.
 */
export function runOwnedCheckoutPort(deps: RunOwnedCheckoutDeps): RunCheckoutPort {
  const grace = deps.graceMs ?? STEP_PROCESS_GRACE_MS;

  /** The processes in `dir` with every live Consola terminal excluded: agents with their trees, shells alone (Call 8). */
  const lookIn = async (
    dir: string,
  ): Promise<
    | { kind: 'none' }
    | { kind: 'present'; processes: Array<{ pid: number; command: string }> }
    | { kind: 'unknown'; why: string }
  > => {
    let snapshot: ProcessSnapshot;
    try {
      snapshot = await deps.processes.snapshot();
    } catch (error) {
      return { kind: 'unknown', why: error instanceof Error ? error.message : String(error) };
    }
    const { agents, shells } = deps.liveTerminals();
    const found = ProcessCwdIndex.inTree(snapshot, dir, new Set(agents), new Set(shells));
    if (found.kind === 'unknown')
      return {
        kind: 'unknown',
        why: "the working directories of this Mac's processes could not be read",
      };
    return found;
  };

  const holder = (dir: string) => {
    const target = path.resolve(dir);
    const held = deps
      .sessions()
      .find(
        (session) =>
          session.running &&
          ((session.cwd !== undefined && path.resolve(session.cwd) === target) ||
            (session.agentCwd !== undefined && path.resolve(session.agentCwd) === target)),
      );
    return held ? { sessionId: held.id, name: held.name } : null;
  };

  /** F7: a session launched in `dir` with full tools, running or not (`launchedWithFullTools`, both paths resolved). */
  const fullToolsSession = (dir: string) => {
    const target = path.resolve(dir);
    const launched = deps
      .sessions()
      .find(
        (session) =>
          session.cwd !== undefined &&
          launchedWithFullTools(
            { cwd: path.resolve(session.cwd), toolPolicy: session.toolPolicy },
            target,
          ),
      );
    return launched ? { sessionId: launched.id, name: launched.name } : null;
  };

  /**
   * Never past a holder or a live process: a Consola session whose CLI runs
   * there, or any other process working there (Consola's terminals
   * excluded as at a step's end), refuses before anything is committed.
   */
  const nothingLive = async (dir: string, who?: string): Promise<string | null> => {
    const held = holder(dir);
    if (held) return sessionHoldsRetry(held.name);
    const found = await lookIn(dir);
    if (found.kind === 'unknown')
      return `Consola couldn't check for processes left in the checkout: ${found.why}`;
    if (found.kind === 'present') {
      if (who !== undefined)
        return `\`${who}\`, opened by you, left a process running in this run's checkout`;
      const [first] = found.processes;
      return `a process outside Consola's sessions is running in this run's checkout (${first.command}, pid ${first.pid}); end it, then retry`;
    }
    return null;
  };

  return {
    pathFor: (runId, repo) => path.join(deps.root, runOwnedDirName(repo, runId)),

    async make(request) {
      const workspace = deps.getWorkspace(request.workspaceId);
      if (!workspace) throw new RunCheckoutError('resolve', `no workspace ${request.workspaceId}`);
      const source = deps.resolveRepo(workspace, request.repo);
      if (!source) throw new RunCheckoutError('resolve', notClonedMessage(request.repo));
      const dir = path.join(deps.root, runOwnedDirName(request.repo, request.runId));
      const fetchEnv = await deps.fetchEnv(workspace);
      // Under the folder's lock, as cleanup's removal and rebuild are: a make again (F10) removes first.
      const { base } = await deps.underLock(dir, () =>
        makeRunClone({
          source,
          dir,
          branch: request.branch,
          ...(request.from !== undefined ? { from: request.from } : {}),
          runId: request.runId,
          fetchEnv,
          ...(request.again ? { again: true } : {}),
        }),
      );
      return { cwd: dir, scopeId: deps.scopeIdForPath(workspace, source), base };
    },

    async settle(request): Promise<SettleResult> {
      const live = await nothingLive(request.dir);
      if (live) return { ok: false, error: live };
      return settleRunClone(request);
    },

    async settleBetween(request) {
      const live = await nothingLive(request.dir, request.session);
      if (live) return { ok: false, error: live };
      return settleBetweenSteps(request);
    },

    reset: (dir, before, branch) => resetRunClone(dir, before, branch),
    changes: (dir, base, head, maxBytes) => runCloneChanges(dir, base, head, maxBytes),
    showAt: (dir, commit, file, maxBytes) => runCloneShowAt(dir, commit, file, maxBytes),
    folderProblem: (dir) => gitFolderProblem(dir),

    async endStepProcesses({ dir, sessionId }): Promise<StepProcesses> {
      const record = sessionId !== undefined ? deps.stepProcesses(sessionId) : null;
      if (record) {
        // Only what is still the process recorded: a pid since reused by another process is left alone.
        const descendants = record.descendants
          .filter((entry) => deps.identify(entry.pid)?.started === entry.started)
          .map((entry) => entry.pid);
        const alive = () => [
          ...(signalled(deps, -record.pgid, 0) ? [-record.pgid] : []),
          ...descendants.filter((pid) => signalled(deps, pid, 0)),
        ];
        for (const target of alive()) signalled(deps, target, 'SIGTERM');
        for (let waited = 0; waited < grace && alive().length > 0; waited += 100) await sleep(100);
        for (const target of alive()) signalled(deps, target, 'SIGKILL');
        if (alive().length > 0) await sleep(100);
        const left = alive();
        if (left.length > 0) return { kind: 'survivors', count: left.length };
      }
      const found = await lookIn(dir);
      if (found.kind === 'none') return { kind: 'clear' };
      if (found.kind === 'unknown') return { kind: 'unknown', why: found.why };
      return { kind: 'strangers', processes: found.processes };
    },

    holder,
    fullToolsSession,

    // Task 19: back at the commit the removal recorded, from the person's clone, keeping its keep-ref (review NB2).
    restore: (dir) =>
      deps.underLock(dir, async () => {
        if (fs.existsSync(dir)) return;
        const { rebuilt } = await deps.restoreAt(dir);
        if (!rebuilt)
          throw new Error(
            `${dir} is gone and nothing records how to rebuild it, so Consola will not make it anew`,
          );
      }),
  };
}

/**
 * Why nothing may start for a session in a run's own checkout (plan Call 9,
 * review NB1): its `cwd` or `agentCwd` is one (a direct child of the
 * worktree root whose git folder is at `runCloneGitDirFor`), and its pointer
 * or git folder is not as Consola made them. Null otherwise. Asked by
 * `TERMINAL_CREATE`, `TERMINAL_RESTART`, a shell opened beside the session
 * and a full-tools continuation's first spawn (`SessionLauncher.spawnRefusal`,
 * the 3-B code review's F11), after any rebuild, before anything is
 * spawned: a step's session reopened, a full-tools continuation in it.
 */
export function runCheckoutSpawnRefusal(
  session: { cwd?: string; agentCwd?: string },
  root: string,
): string | null {
  for (const dir of [session.cwd, session.agentCwd]) {
    if (dir === undefined) continue;
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(root)) continue;
    if (!fs.existsSync(runCloneGitDirFor(resolved))) continue;
    const problem = gitFolderProblem(resolved);
    if (problem) return folderChangedMessage(problem);
  }
  return null;
}
