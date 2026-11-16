/**
 * What each window is looking at, and whether it is looking.
 *
 * Renderers report two facts per window, a session and focus, and only main
 * combines them: an unfocused window showing a session has not seen it. The
 * combination is the whole of what counts as "seen"; nothing in a renderer
 * decides that.
 */
export class ViewingTracker {
  private readonly windows = new Map<number, { viewing: string | null; focused: boolean }>();

  /** `onViewed` hears each time a window comes to be looking at a terminal. */
  constructor(private readonly onViewed: (instanceId: string) => void) {}

  public viewing(windowId: number, instanceId: string | null): void {
    const before = this.effective(windowId);
    this.windows.set(windowId, { viewing: instanceId, focused: this.windows.get(windowId)?.focused ?? false });
    this.announce(windowId, before);
  }

  public focused(windowId: number, focused: boolean): void {
    const before = this.effective(windowId);
    this.windows.set(windowId, { viewing: this.windows.get(windowId)?.viewing ?? null, focused });
    this.announce(windowId, before);
  }

  public closed(windowId: number): void {
    this.windows.delete(windowId);
  }

  /** Whether any focused window shows this terminal. */
  public isViewedInFocusedWindow(instanceId: string): boolean {
    for (const id of this.windows.keys()) if (this.effective(id) === instanceId) return true;
    return false;
  }

  /** Whether any window shows this terminal, focused or not. */
  public isShown(instanceId: string): boolean {
    for (const state of this.windows.values()) if (state.viewing === instanceId) return true;
    return false;
  }

  private effective(windowId: number): string | null {
    const state = this.windows.get(windowId);
    return state?.focused ? state.viewing : null;
  }

  private announce(windowId: number, before: string | null): void {
    const now = this.effective(windowId);
    if (now !== null && now !== before) this.onViewed(now);
  }
}
