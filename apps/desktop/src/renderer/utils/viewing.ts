import type { Workspace } from '../../shared/workspace';

/** What a window shows, as far as "is it looking at this session" cares. */
interface ViewState {
  activeSessionId: string | null;
  overlay: string | null;
}

/**
 * The session this window is showing, or null when it shows none.
 *
 * An overlay covers the pane, so a session behind the Inbox is running but not
 * being looked at. This is the one place that says so: `viewedInstanceId`
 * (what main is told) and `isSessionViewed` (what a row masks) both build on
 * it, so the two cannot disagree. Whether the window is focused is a separate
 * fact, reported separately: main combines the two.
 */
export function viewedSessionId(view: ViewState): string | null {
  return view.overlay === null ? view.activeSessionId : null;
}

/** The terminal this window is showing, or null when it shows none. */
export function viewedInstanceId(view: ViewState, workspace: Workspace | undefined): string | null {
  const sessionId = viewedSessionId(view);
  if (!sessionId || !workspace) return null;
  return workspace.sessions.find((session) => session.id === sessionId)?.instanceId ?? null;
}

/** Where a report goes; the attention bridge in the app. */
export interface ViewingSink {
  setViewing(instanceId: string | null): void;
  setFocused(focused: boolean): void;
}

/** Forwards changes only, so a re-render that changes nothing sends nothing. */
export class ViewingReporter {
  private viewing: string | null | undefined;
  private focused: boolean | undefined;

  constructor(private readonly sink: ViewingSink) {}

  public view(instanceId: string | null): void {
    if (instanceId === this.viewing) return;
    this.viewing = instanceId;
    this.sink.setViewing(instanceId);
  }

  public focus(focused: boolean): void {
    if (focused === this.focused) return;
    this.focused = focused;
    this.sink.setFocused(focused);
  }
}

/**
 * Whether this window is reporting `sessionId` as viewed: it is the one shown,
 * no overlay covers it, and the window has focus. Built on `viewedSessionId`,
 * which `viewedInstanceId` (and so `useViewingReport`) is also built on.
 */
export function isSessionViewed(view: ViewState, sessionId: string, focused: boolean): boolean {
  return focused && viewedSessionId(view) === sessionId;
}
