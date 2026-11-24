import type { Session } from '../shared/workspace';

/** What deciding to let a removed worktree's keep-ref go reads. */
export interface KeepRefReleaseDeps {
  /** Whether any session still names the folder in its `removedWorktree`. */
  stillNamed(worktreePath: string): boolean;
  /** Whether a run in history names the folder as its own checkout (slice 3-B): it can still rebuild it. */
  runNames(worktreePath: string): boolean;
  exists(worktreePath: string): boolean;
  deleteKeepRef(mainRepo: string, ref: string): Promise<void>;
}

/**
 * `SessionRemover`'s `releaseRemovedWorktree`: once a deleted session's
 * removed worktree is named by no other session, nothing will rebuild it,
 * and its keep-ref goes. A run's own checkout (slice 3-B, review NB2) is
 * also its run's: its keep-ref stays while a run in history names the
 * folder, and while the folder exists (a rebuilt clone borrows its
 * objects from the person's clone, so the keep-ref is what keeps them).
 */
export function releaseRemovedWorktreeWith(
  deps: KeepRefReleaseDeps,
): (session: Pick<Session, 'removedWorktree'>) => void {
  return ({ removedWorktree: removed }) => {
    if (!removed) return;
    if (deps.stillNamed(removed.path)) return;
    if (removed.kind === 'run-owned' && (deps.runNames(removed.path) || deps.exists(removed.path)))
      return;
    void deps
      .deleteKeepRef(removed.mainRepo, removed.keepRef)
      .catch((error: unknown) => console.error(`Could not delete ${removed.keepRef}:`, error));
  };
}

export interface SessionRemoverDeps {
  /** WorkspaceService.deleteSession: writes to disk, and throws if it cannot. */
  deleteRecord(workspaceId: string, sessionId: string): void;
  /** The agent PTY and its attention state (badge, notification edge). */
  destroyTerminal(instanceId: string): void;
  destroyShell(instanceId: string): void;
  /** The session's browser tabs and the pages behind them. */
  destroyBrowser(sessionId: string): void;
  /** The screenshots it sent from its browser, as files. */
  removeCaptures(sessionId: string): Promise<void>;
  /** The session's MCP endpoint: socket, config file and live connections. */
  releaseMcp(sessionId: string): void;
  /**
   * The handoff documents its harness switches wrote. Kept while the record
   * is — a later handoff points back at an earlier one — and gone with it.
   */
  removeHandoffs(sessionId: string): Promise<void>;
  /**
   * A session whose worktree a cleanup rule removed held the keep-ref that
   * would rebuild it; once no session names that folder, nothing will.
   */
  releaseRemovedWorktree?(session: Pick<Session, 'removedWorktree'>): void;
}

/**
 * The one way a session goes away in main.
 *
 * Before this, deleting was split: the record went over one IPC call and the
 * PTY over another the renderer sent afterwards. Anything that deletes from
 * main — a cleanup tool, an automation — has no renderer to send the second
 * half, and would leave a terminal running for a session no window can name.
 */
export class SessionRemover {
  constructor(private readonly deps: SessionRemoverDeps) {}

  /**
   * Stop everything the session runs, leaving its record. Idempotent: what
   * a cleanup does before touching the session's worktree, and the second
   * half of `remove`.
   */
  public stop(session: Pick<Session, 'id' | 'instanceId'>): void {
    this.deps.destroyTerminal(session.instanceId);
    this.deps.destroyShell(session.instanceId);
    this.deps.releaseMcp(session.id);
  }

  /**
   * Delete the record, then stop the session. The record goes first because
   * it is the only step that can fail: a failed write leaves the session —
   * terminal included — exactly as it was, rather than a live record whose
   * terminal was already killed.
   */
  public remove(
    workspaceId: string,
    session: Pick<Session, 'id' | 'instanceId' | 'removedWorktree'>,
  ): void {
    this.deps.deleteRecord(workspaceId, session.id);
    this.discard(session);
  }

  /**
   * Stop a session whose record is already gone — removed above, or with
   * its whole workspace — and delete what only that record could name.
   */
  public discard(session: Pick<Session, 'id' | 'instanceId' | 'removedWorktree'>): void {
    this.stop(session);
    // Not in stop(): a stopped session keeps its record, and its tabs with it.
    // On its own, so a browser teardown that throws cannot skip what follows,
    // nor a workspace delete's clearing of its logins after it.
    try {
      this.deps.destroyBrowser(session.id);
    } catch (error) {
      console.error(`Could not close the browser tabs of session ${session.id}:`, error);
    }
    try {
      this.deps.removeCaptures(session.id).catch((error: unknown) => {
        console.error(`Could not delete the browser captures of session ${session.id}:`, error);
      });
    } catch (error) {
      console.error(`Could not delete the browser captures of session ${session.id}:`, error);
    }
    try {
      this.deps.releaseRemovedWorktree?.(session);
    } catch (error) {
      console.error(`Could not release the removed worktree of session ${session.id}:`, error);
    }
    this.deps.removeHandoffs(session.id).catch((error: unknown) => {
      console.error(`Could not delete the handoff documents of session ${session.id}:`, error);
    });
  }
}
