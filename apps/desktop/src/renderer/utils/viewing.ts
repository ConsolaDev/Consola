import type { Workspace } from '../../shared/workspace';

/**
 * The terminal this window is showing, or null when it shows none.
 *
 * An overlay covers the pane, so a session behind the Inbox is running but not
 * being looked at. Whether the window is focused is a separate fact, reported
 * separately: main combines the two.
 */
export function viewedInstanceId(
  view: { activeSessionId: string | null; overlay: string | null },
  workspace: Workspace | undefined
): string | null {
  if (view.overlay !== null || !view.activeSessionId || !workspace) return null;
  return workspace.sessions.find((session) => session.id === view.activeSessionId)?.instanceId ?? null;
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
