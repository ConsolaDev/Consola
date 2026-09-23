import type { WorkspaceView } from '../../shared/types';
import type { Workspace } from '../../shared/workspace';
import { JsonStateFile } from './JsonStateFile';

/** The on-disk shape: one remembered view per workspace id. */
export interface ViewMemoryStateFile {
  views: Record<string, WorkspaceView>;
}

/** What a workspace shows with nothing remembered — today's blank composer. */
export const EMPTY_VIEW: WorkspaceView = { activeSessionId: null, isInboxOpen: false };

/**
 * Whether a stored entry is shaped the way we wrote it.
 *
 * `view-memory.json` is an ordinary file: a user can edit it and a crash can
 * truncate it. One malformed entry is skipped on its own rather than costing
 * every other workspace its memory, the same way `isStoredWindow` treats one
 * bad window entry.
 */
export function isValidView(value: unknown): value is WorkspaceView {
  if (typeof value !== 'object' || value === null) return false;
  const { activeSessionId, isInboxOpen } = value as Record<string, unknown>;
  if (activeSessionId !== null && typeof activeSessionId !== 'string') return false;
  return typeof isInboxOpen === 'boolean';
}

/**
 * Narrow a remembered view to what the workspace can actually show now.
 *
 * The single place staleness collapses to "nothing remembered", consulted
 * identically whether a view is being restored at window construction or
 * fetched mid-session on a switch. Because it runs on every read, nothing
 * upstream has to eagerly clean up: a session deleted from another window, a
 * provider unbound, a workspace removed — each is caught here the next time
 * anyone asks.
 *
 * A dangling session id resolves to `null`, never to a substitute session.
 * Selecting a session mounts its pane and spawns a PTY, so landing on a
 * workspace must never launch an agent the user did not ask for.
 */
export function resolveRememberedView(
  view: WorkspaceView,
  workspace: Workspace | undefined
): WorkspaceView {
  if (!workspace) return EMPTY_VIEW;

  const sessionStillExists =
    view.activeSessionId !== null &&
    workspace.sessions.some((session) => session.id === view.activeSessionId);

  return {
    activeSessionId: sessionStillExists ? view.activeSessionId : null,
    // The sidebar only offers the Inbox to a bound workspace, so a remembered
    // `true` outlives the binding it was set under. MainContent guards this
    // too, but resolving it here keeps main the one authority on what a
    // workspace is showing rather than leaving a latent flag set.
    isInboxOpen: view.isInboxOpen && workspace.provider !== undefined,
  };
}

/**
 * Where each workspace was left, so returning to one lands where you were.
 *
 * Keyed by workspace rather than by window because that is the fact worth
 * keeping: a workspace outlives the window that showed it, and main already
 * guarantees at most one window holds a workspace at a time, so an entry can
 * never be raced by two writers.
 *
 * Deliberately not a field on the `Workspace` record. Every write there is a
 * synchronous fsync of the whole workspace list plus a full snapshot pushed to
 * every window — a price worth paying for renaming a workspace, and absurd for
 * clicking a session in the sidebar. This file holds two fields per workspace
 * and nothing subscribes to it, so a write costs almost nothing and wakes no
 * one.
 */
export class ViewMemoryService {
  private views = new Map<string, WorkspaceView>();

  constructor(private readonly file: JsonStateFile<ViewMemoryStateFile>) {}

  /**
   * Read the file, skipping anything malformed.
   *
   * Never fatal, unlike `workspaces.json` and `harnesses.json`. Losing this
   * file costs every workspace its remembered view — which is exactly the
   * documented behaviour for a workspace that has none — where losing those
   * orphans real transcripts. Halting the app over it would be the larger bug.
   */
  public load(): void {
    let stored: { views?: unknown } | null = null;
    try {
      stored = this.file.read() as { views?: unknown } | null;
    } catch {
      // A corrupt file and its backup: start empty rather than refuse to launch.
      return;
    }

    const views = stored?.views;
    if (typeof views !== 'object' || views === null) return;

    for (const [workspaceId, view] of Object.entries(views)) {
      if (isValidView(view)) this.views.set(workspaceId, view);
    }
  }

  /** Whether anything has ever been remembered. */
  public isEmpty(): boolean {
    return this.views.size === 0;
  }

  /**
   * Adopt views carried over from an older build, in one write.
   *
   * Only meaningful on the launch that first creates this file: without it,
   * everyone's very first switch after upgrading would land on the blank
   * composer even though main knew perfectly well where they were.
   */
  public seed(views: Record<string, WorkspaceView>): void {
    for (const [workspaceId, view] of Object.entries(views)) {
      this.views.set(workspaceId, view);
    }
    if (this.views.size > 0) this.write();
  }

  /** What this workspace was last showing, unresolved. */
  public get(workspaceId: string): WorkspaceView {
    return this.views.get(workspaceId) ?? EMPTY_VIEW;
  }

  /**
   * Remember what a workspace is showing, and persist it now.
   *
   * Written eagerly rather than at quit: this is the one record of where the
   * user was, and a force-quit is exactly the moment it has to survive. The
   * file is two fields per workspace and every caller is a human-rate click,
   * so the write is cheap enough not to need a debounce — and an unchanged
   * view skips it entirely, which is what clicking the session you are
   * already on does.
   */
  public set(workspaceId: string, view: WorkspaceView): void {
    const current = this.views.get(workspaceId);
    if (
      current &&
      current.activeSessionId === view.activeSessionId &&
      current.isInboxOpen === view.isInboxOpen
    ) {
      return;
    }

    this.views.set(workspaceId, view);
    this.write();
  }

  /** Drop every workspace that no longer exists. */
  public prune(liveWorkspaceIds: Set<string>): void {
    let removed = false;
    for (const workspaceId of this.views.keys()) {
      if (!liveWorkspaceIds.has(workspaceId)) {
        this.views.delete(workspaceId);
        removed = true;
      }
    }
    if (removed) this.write();
  }

  /**
   * Persist, keeping the in-memory map authoritative on failure.
   *
   * A failed write must not cost the running app its memory: the map is what
   * every read goes through, and this file only has to be right by the time
   * the app is relaunched.
   */
  private write(): void {
    try {
      this.file.write({ views: Object.fromEntries(this.views) });
    } catch {
      // Losing a view to a failed write is a small cost, and there is no
      // surface to report it on. Throwing would propagate out of an
      // ipcMain.on listener, where nothing is waiting to catch it.
    }
  }
}
