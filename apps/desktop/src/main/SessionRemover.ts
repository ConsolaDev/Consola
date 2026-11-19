import type { Session } from '../shared/workspace';

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
    this.deps.destroyBrowser(session.id);
    try {
      this.deps.removeCaptures(session.id).catch((error) => {
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
    this.deps.removeHandoffs(session.id).catch((error) => {
      console.error(`Could not delete the handoff documents of session ${session.id}:`, error);
    });
  }
}
