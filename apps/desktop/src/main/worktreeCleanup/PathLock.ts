import * as fs from 'node:fs';
import * as path from 'node:path';

/** How long a folder someone just prepared counts as in use before any session names it. */
export const RECENTLY_PREPARED_MS = 10 * 60_000;

/**
 * One lock per worktree folder, keyed by its resolved path.
 *
 * Everything that creates, moves or removes a worktree folder takes it:
 * removal, rebuild, `ensureWorktree`, `refreshPullRequest` and a new session's
 * checkout. Without it a removal could run between `ensureWorktree` handing a
 * folder back and the session record that names it being written, and the
 * session would start in a folder that is gone.
 *
 * Callers that also hold a per-item chain (`chainWorktreeStep`) take that one
 * first: item chain outside, path lock inside, always in that order.
 *
 * Not reentrant. Code already holding the lock calls the unlocked variant of
 * whatever it needs.
 */
export class PathLock {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly prepared = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Run `work` with the folder's lock held. A failed `work` never poisons the chain. */
  public run<T>(dir: string, work: () => Promise<T>): Promise<T> {
    const key = lockKey(dir);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const started = previous.catch(() => undefined).then(work);
    const settled = started
      .catch(() => undefined)
      .then(() => {
        if (this.chains.get(key) === settled) this.chains.delete(key);
      });
    this.chains.set(key, settled);
    return started;
  }

  /**
   * Note that a folder was just handed to someone about to start a session
   * in it. Removal treats it as in use for `RECENTLY_PREPARED_MS`: the
   * session record that will name it may not exist yet.
   */
  public markPrepared(dir: string): void {
    this.prepared.set(lockKey(dir), this.now());
  }

  public recentlyPrepared(dir: string): boolean {
    const key = lockKey(dir);
    const at = this.prepared.get(key);
    if (at === undefined) return false;
    if (this.now() - at < RECENTLY_PREPARED_MS) return true;
    this.prepared.delete(key);
    return false;
  }
}

/**
 * The folder's real path, or for one that does not exist yet, its parent's
 * real path joined with its name: a lock taken before `worktree add` and one
 * taken after must agree.
 */
export function lockKey(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

/** The one lock every worktree owner in this process shares. */
export const worktreePathLock = new PathLock();
