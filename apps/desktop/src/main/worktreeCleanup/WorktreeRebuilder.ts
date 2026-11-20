import type { Session, Workspace } from '../../shared/workspace';
import type { RemovedWorktree } from '../../shared/worktreeCleanup';
import { describeError } from '../describeError';
import type { RestoreResult } from '../WorktreeService';
import { lockKey, type PathLock } from './PathLock';

export interface RebuilderDeps {
  lock: Pick<PathLock, 'run' | 'markPrepared'>;
  getWorkspaces(): Workspace[];
  worktrees: {
    restore(removed: RemovedWorktree): Promise<RestoreResult>;
    deleteKeepRef(mainRepo: string, ref: string): Promise<void>;
  };
  /** Clear `removedWorktree` from every session naming this path. */
  clearRemoved(worktreePath: string): void;
  /** For the history. */
  rebuilt?(removed: RemovedWorktree, result: RestoreResult): void;
}

/** What opening a session whose worktree was removed did. */
export interface Rebuild {
  rebuilt: boolean;
  /** A line for the pane, above the CLI. Absent when there was nothing to say. */
  notice?: string;
}

/**
 * Puts a removed worktree back, at the same path and on the recorded commit,
 * when its session is opened.
 *
 * Never through `ensureWorktree`, `refreshPullRequest` or the provider's
 * checkout: those move to a pull request's latest head. Claude trusts a
 * folder per path, so a full-tools session rebuilt onto commits it never saw
 * would load their hooks and settings with no trust prompt. The same path
 * also keeps `--resume` and the agent's view of the folder consistent.
 *
 * And only this recreates a folder a `removedWorktree` record names: an
 * Inbox click or an automation run that lands on such a path hands it here
 * first (`restoreAt`), or it would recreate it at the latest head.
 */
export class WorktreeRebuilder {
  constructor(private readonly deps: RebuilderDeps) {}

  /**
   * Make the session's checkout exist again, if a rule removed it. No IO at
   * all for a session that was never removed. Throws with a sentence for the
   * pane when it cannot, keeping the record so a later open can try again.
   */
  public async ensureCheckout(_workspace: Workspace, session: Session): Promise<Rebuild> {
    const removed = session.removedWorktree;
    if (!removed) return { rebuilt: false };
    return this.deps.lock.run(removed.path, () => this.restoreUnlocked(removed.path));
  }

  /**
   * For a caller already holding the folder's lock (`ensureWorktree`): put
   * back the worktree a record names at `dir`, if any does.
   */
  public async restoreAt(dir: string): Promise<Rebuild> {
    return this.restoreUnlocked(dir);
  }

  private async restoreUnlocked(dir: string): Promise<Rebuild> {
    // Read again under the lock: another open may have rebuilt it meanwhile.
    const removed = this.recordFor(dir);
    if (!removed) return { rebuilt: false };

    let result: RestoreResult;
    try {
      result = await this.deps.worktrees.restore(removed);
    } catch (error) {
      throw new Error(`Consola could not rebuild this session's worktree: ${describeError(error)}`);
    }
    this.deps.clearRemoved(removed.path);
    this.deps.lock.markPrepared(removed.path);
    await this.deps.worktrees.deleteKeepRef(removed.mainRepo, removed.keepRef).catch(() => {});
    try {
      this.deps.rebuilt?.(removed, result);
    } catch (error) {
      console.error('Could not record a worktree rebuild:', error);
    }
    const notice = noticeFor(removed, result);
    return { rebuilt: result.kind === 'rebuilt', ...(notice ? { notice } : {}) };
  }

  private recordFor(dir: string): RemovedWorktree | undefined {
    // By real path, the way the lock is keyed: the root may be reached
    // through a symlink, and the record names the folder as it was resolved.
    const target = lockKey(dir);
    for (const workspace of this.deps.getWorkspaces()) {
      for (const session of workspace.sessions) {
        const removed = session.removedWorktree;
        if (removed && lockKey(removed.path) === target) return removed;
      }
    }
    return undefined;
  }
}

function noticeFor(removed: RemovedWorktree, result: RestoreResult): string {
  const short = removed.commit.slice(0, 7);
  if (result.kind === 'existed') {
    return result.head === removed.commit
      ? ''
      : `This worktree was found at ${result.head.slice(0, 7)}, not ${short} where Consola left it; it was left as it is.`;
  }
  const where = result.branch
    ? `on ${result.branch} at ${short}`
    : removed.branch
      ? `at ${short}, detached: ${removed.branch} has moved since`
      : `at ${short}, detached`;
  return `Consola rebuilt this session's worktree ${where}. Dependencies and build output were not restored.`;
}
