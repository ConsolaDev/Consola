import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCloneGitDirFor } from '@consola/automation-engine';
import type { Session } from '../../shared/workspace';
import { keepRefFor } from '../../shared/worktreeCleanup';
import type { CleanupTrigger, RemovedWorktree, TreeVerdict } from '../../shared/worktreeCleanup';
import { describeError } from '../describeError';
import type { WorktreeInspection } from '../WorktreeService';
import type { GatherOptions, Gathered } from './FactGatherer';
import type { PathLock } from './PathLock';
import { judge } from './policy';
import type { UserFacts } from './policy';
import { ProcessCwdIndex } from './ProcessCwdIndex';
import type { ProcessSnapshot } from './ProcessCwdIndex';

/** What one removal did. */
export type Execution =
  | {
      kind: 'removed';
      verdict: Extract<TreeVerdict, { decision: 'remove' }>;
      inspection: WorktreeInspection;
      branch: 'deleted' | 'kept' | 'none';
      notes: string[];
    }
  | { kind: 'kept'; verdict: Extract<TreeVerdict, { decision: 'keep' }> }
  | { kind: 'failed'; error: string };

export interface ExecutorDeps {
  lock: Pick<PathLock, 'run'>;
  gather(tree: string, options: GatherOptions): Promise<Gathered>;
  /** The sessions on the tree now, with their own facts, read cheaply. */
  usersNow(tree: string, options: GatherOptions): { sessions: Session[]; users: UserFacts[] };
  /** Stop a session's terminal, shell and MCP endpoint, keeping its record. */
  stop(session: Pick<Session, 'id' | 'instanceId'>): void;
  processes: Pick<ProcessCwdIndex, 'snapshot'>;
  worktrees: {
    removeWorktree(inspection: WorktreeInspection): Promise<void>;
    deleteBranchAt(
      mainRepo: string,
      branch: string,
      expectedHead: string,
    ): Promise<{ deleted: true } | { deleted: false; reason: string }>;
    writeKeepRef(mainRepo: string, ref: string, commit: string): Promise<void>;
    deleteKeepRef(mainRepo: string, ref: string): Promise<void>;
    /** What a keep-ref points at now, or null. */
    keepRefAt(mainRepo: string, ref: string): Promise<string | null>;
    /** A run's own checkout's branch into its clone as `keepRef`, which must then be its head (slice 3-B, Call 10). */
    fetchKeepRef(inspection: WorktreeInspection, keepRef: string): Promise<void>;
    /** A run's own checkout and its git folder, gone; refuses anything else. */
    removeRunClone(inspection: WorktreeInspection): Promise<void>;
  };
  /** Mark every listed session's worktree removed, in one write. */
  recordRemoved(entries: Array<{ sessionId: string; removed: RemovedWorktree }>): void;
  /**
   * The run's own record of its removed checkout (slice 3-B, review S3:
   * a run of only `run:` steps has no session to carry it), or `null` to
   * clear it: `AutomationService.recordCheckoutRemoved`.
   */
  recordRunCheckoutRemoved?(
    runId: string,
    removed: { commit: string; keepRef: string; at: string } | null,
  ): void;
  /** Clear the mark from every session naming this path. */
  clearRemoved(worktreePath: string): void;
  /** Called after a removal, for the history. */
  removed?(execution: Extract<Execution, { kind: 'removed' }>): void;
  now(): number;
  /** Wait between process checks after stopping the sessions. */
  sleep?(ms: number): Promise<void>;
}

/** Rules that leave the session in place: those keep a ref and a record to rebuild from. */
const SESSION_STAYS: ReadonlySet<CleanupTrigger> = new Set([
  'pr-finished',
  'settled',
  'run-finished',
]);

/** How long a stopped session's processes get to leave the folder. */
const PROCESS_EXIT_WAIT_MS = 3_000;
const PROCESS_POLL_MS = 250;

/**
 * The only code that removes a worktree folder.
 *
 * Under the folder's lock, and in this order:
 *
 * 1. Judge again, from fresh facts. A preview may be minutes old.
 * 2. Stop every session on it.
 * 3. Check processes again, now with nothing excused, and give the stopped
 *    sessions a moment to exit. Anything still running keeps the folder.
 * 4. For a session that stays: a keep-ref at HEAD, then the record on every
 *    session (`removedWorktree`). Record before removal: a crash in between
 *    leaves a record over a folder that still exists, which the rebuilder
 *    reads as "exists" and clears.
 * 5. `git worktree remove`, never `--force`: git's own refusal of a dirty
 *    tree is the last guard. If it refuses, the records are cleared.
 * 6. Only when the verdict says so, the branch, compare-and-swap at HEAD.
 *
 * A run's own checkout (slice 3-B) is a clone, so steps 4–6 differ
 * (`removeRunOwned`): the keep-ref is fetched into the person's clone,
 * the record goes on the run too, and the clone goes whole.
 */
export class WorktreeExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  public remove(tree: string, options: GatherOptions): Promise<Execution> {
    return this.deps.lock.run(tree, () => this.removeLocked(tree, options));
  }

  private async removeLocked(tree: string, options: GatherOptions): Promise<Execution> {
    const gathered = await this.deps.gather(tree, { ...options, thorough: false });
    const first = judge(gathered.facts, options.request);
    if (first.decision === 'keep') return { kind: 'kept', verdict: first };
    const inspection = gathered.inspection;
    if (!inspection) return { kind: 'failed', error: `${tree} could not be read.` };

    // The slow checks above took seconds. The sessions' own state is read
    // again now, and judged with what the folder said: a session opened, or
    // started on this tree, meanwhile keeps it — and only the sessions just
    // judged are stopped and recorded.
    const now = this.deps.usersNow(tree, options);
    const verdict = judge({ ...gathered.facts, users: now.users }, options.request);
    if (verdict.decision === 'keep') return { kind: 'kept', verdict };
    const sessions = now.sessions;
    for (const session of sessions) this.deps.stop(session);
    const left = await this.processesLeft(tree);
    if (left) return { kind: 'kept', verdict: { ...keep(verdict), blockers: [left] } };

    const stays = SESSION_STAYS.has(verdict.trigger);
    const keepRef = keepRefFor(tree);
    if (inspection.runOwned) {
      return this.removeRunOwned(verdict, inspection, stays ? sessions : [], keepRef);
    }
    if (stays) {
      try {
        await this.deps.worktrees.writeKeepRef(inspection.mainRepo, keepRef, inspection.head);
        const removed: RemovedWorktree = {
          path: tree,
          mainRepo: inspection.mainRepo,
          commit: inspection.head,
          branch: inspection.branch,
          keepRef,
          trigger: verdict.trigger,
          removedAt: this.deps.now(),
        };
        this.deps.recordRemoved(sessions.map((session) => ({ sessionId: session.id, removed })));
      } catch (error) {
        await this.deps.worktrees.deleteKeepRef(inspection.mainRepo, keepRef).catch(() => {});
        return { kind: 'failed', error: describeError(error) };
      }
    }

    try {
      await this.deps.worktrees.removeWorktree(inspection);
    } catch (error) {
      // Git refused before touching anything: the folder is whole, and the
      // records would only claim a removal that never happened. A removal
      // that failed part-way, with the folder gone or no longer a worktree,
      // keeps both, so opening the session rebuilds it from the keep-ref.
      const whole = fs.existsSync(path.join(tree, '.git'));
      if (stays && whole) {
        this.safely(() => this.deps.clearRemoved(tree));
        await this.deps.worktrees.deleteKeepRef(inspection.mainRepo, keepRef).catch(() => {});
      }
      const kept = stays && !whole ? ' Opening its session rebuilds it.' : '';
      return { kind: 'failed', error: `${describeError(error)}${kept}` };
    }

    const notes: string[] = [];
    let branch: 'deleted' | 'kept' | 'none' = inspection.branch ? 'kept' : 'none';
    if (verdict.branch === 'delete-at-head' && inspection.branch) {
      const deleted = await this.deps.worktrees.deleteBranchAt(
        inspection.mainRepo,
        inspection.branch,
        inspection.head,
      );
      branch = deleted.deleted ? 'deleted' : 'kept';
      if (!deleted.deleted) notes.push(`Branch kept: ${deleted.reason}.`);
    }
    const execution: Extract<Execution, { kind: 'removed' }> = {
      kind: 'removed',
      verdict,
      inspection,
      branch,
      notes,
    };
    this.safely(() => this.deps.removed?.(execution));
    return execution;
  }

  /**
   * A run's own checkout, in this order (plan Call 10): its branch fetched
   * into the person's clone as the keep-ref, which must be the head just
   * judged (a moved branch removes nothing); the record, on every session
   * that stays and on its run while history has it, so Retry can rebuild a
   * run with no session; then both folders. Always a record and a keep-ref,
   * whatever the trigger: the run outlives its sessions, and a failed run
   * can be retried. The keep-ref is never deleted here: after a rebuild it
   * is what keeps the folder's commits from `gc` (review NB2), so a failed
   * fetch puts back the one it replaced, and a failed removal leaves it.
   */
  private async removeRunOwned(
    verdict: Extract<TreeVerdict, { decision: 'remove' }>,
    inspection: WorktreeInspection,
    sessions: Session[],
    keepRef: string,
  ): Promise<Execution> {
    const tree = verdict.tree;
    const runId = inspection.runOwned!.runId;
    const { mainRepo, head, branch } = inspection;
    const previous = await this.deps.worktrees.keepRefAt(mainRepo, keepRef).catch(() => null);
    try {
      await this.deps.worktrees.fetchKeepRef(inspection, keepRef);
    } catch (error) {
      if (previous) {
        await this.deps.worktrees.writeKeepRef(mainRepo, keepRef, previous).catch(() => {});
      }
      return { kind: 'failed', error: describeError(error) };
    }
    const at = this.deps.now();
    const removed: RemovedWorktree = {
      path: tree,
      mainRepo,
      commit: head,
      branch,
      keepRef,
      trigger: verdict.trigger,
      removedAt: at,
      kind: 'run-owned',
      runId,
    };
    const forget = () => {
      this.safely(() => this.deps.clearRemoved(tree));
      this.safely(() => this.deps.recordRunCheckoutRemoved?.(runId, null));
    };
    try {
      if (sessions.length > 0) {
        this.deps.recordRemoved(sessions.map((session) => ({ sessionId: session.id, removed })));
      }
      this.deps.recordRunCheckoutRemoved?.(runId, {
        commit: head,
        keepRef,
        at: new Date(at).toISOString(),
      });
    } catch (error) {
      forget();
      return { kind: 'failed', error: describeError(error) };
    }
    try {
      await this.deps.worktrees.removeRunClone(inspection);
    } catch (error) {
      // Refused before anything went: the records would only claim a removal that never
      // happened. Part-way, the records stay, so a Retry or an open rebuilds it.
      const whole =
        fs.existsSync(path.join(tree, '.git')) && fs.existsSync(runCloneGitDirFor(tree));
      if (whole) forget();
      const kept = whole ? '' : ' Retrying its run or opening its session rebuilds it.';
      return { kind: 'failed', error: `${describeError(error)}${kept}` };
    }
    const execution: Extract<Execution, { kind: 'removed' }> = {
      kind: 'removed',
      verdict,
      inspection,
      // Its branch lived in its own clone; the keep-ref keeps the commit and a rebuild the branch.
      branch: 'none',
      notes: [],
    };
    this.safely(() => this.deps.removed?.(execution));
    return execution;
  }

  /** What still runs in the folder once its sessions were told to stop. Null when nothing does. */
  private async processesLeft(tree: string) {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = this.deps.now() + PROCESS_EXIT_WAIT_MS;
    let snapshot: ProcessSnapshot;
    let found: ReturnType<typeof ProcessCwdIndex.inTree>;
    for (;;) {
      snapshot = await this.deps.processes.snapshot();
      found = ProcessCwdIndex.inTree(snapshot, tree);
      if (found.kind === 'none') return null;
      if (found.kind === 'unknown' || this.deps.now() >= deadline) break;
      await sleep(PROCESS_POLL_MS);
    }
    if (found.kind === 'unknown') {
      return {
        kind: 'unknown' as const,
        detail: 'Consola could not check for processes running in it',
      };
    }
    const names = [...new Set(found.processes.map((entry) => entry.command || 'a process'))];
    return {
      kind: 'process' as const,
      detail: `${names.slice(0, 3).join(', ')} ${found.processes.length === 1 ? 'is' : 'are'} still running in it`,
    };
  }

  private safely(work: () => void): void {
    try {
      work();
    } catch (error) {
      console.error('Worktree cleanup could not record what it did:', error);
    }
  }
}

function keep(
  verdict: Extract<TreeVerdict, { decision: 'remove' }>,
): Extract<TreeVerdict, { decision: 'keep' }> {
  return { decision: 'keep', tree: verdict.tree, sessionIds: verdict.sessionIds, blockers: [] };
}
