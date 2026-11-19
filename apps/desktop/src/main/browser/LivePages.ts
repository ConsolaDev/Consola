import type { BrowserWindow } from 'electron';
import { decideLive } from './livePolicy';

/**
 * Which tabs have a page right now, and the facts `decideLive` judges them by.
 *
 * A tab is live from the moment someone needs its page (the person shows it,
 * an agent calls on it) until the rule unloads it. Being live is a decision
 * main makes, not a fact about a guest: the window mounts a page for every
 * live tab, and a guest binds to it afterwards. So the set can name a tab
 * whose element has not attached yet, and a snapshot saying `live: false` is
 * what makes the window remove an element.
 *
 * Holds no guests and does no IO, only the bookkeeping the rule reads.
 */
export class LivePages {
  /** Live tabs, with the window that mounts each (undefined when none holds it). */
  private readonly pages = new Map<string, BrowserWindow | undefined>();
  private readonly shownAt = new Map<string, number>();
  /** The tab each window is showing. */
  private readonly visible = new Map<BrowserWindow, string>();
  /** Tool calls in flight, per tab: calls can overlap. */
  private readonly calls = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  public has(tabId: string): boolean {
    return this.pages.has(tabId);
  }

  /** Makes a tab live and counts it as just shown. True when it was not live before. */
  public add(tabId: string, window: BrowserWindow | undefined): boolean {
    const added = !this.pages.has(tabId);
    this.pages.set(tabId, window);
    this.shownAt.set(tabId, this.now());
    return added;
  }

  /** The tab is gone, or its page is. What a window shows is its own report and is left to it. */
  public drop(tabId: string): void {
    this.pages.delete(tabId);
    this.shownAt.delete(tabId);
    this.calls.delete(tabId);
  }

  /** A window shows this tab, or nothing. What it showed before counts as shown just now. */
  public setVisible(window: BrowserWindow, tabId: string | null): void {
    const previous = this.visible.get(window);
    if (previous !== undefined && this.pages.has(previous)) this.shownAt.set(previous, this.now());
    if (tabId === null) this.visible.delete(window);
    else this.visible.set(window, tabId);
  }

  /**
   * A tool call is under way on a tab: its page stays, and is live if it was
   * not. The returned function ends the call; the tab then counts as just
   * used, so it is not unloaded the instant the call returns.
   */
  public hold(
    tabId: string,
    window: BrowserWindow | undefined,
  ): { added: boolean; release(): void } {
    const added = this.add(tabId, window);
    this.calls.set(tabId, (this.calls.get(tabId) ?? 0) + 1);
    let released = false;
    return {
      added,
      release: () => {
        if (released) return;
        released = true;
        const left = (this.calls.get(tabId) ?? 1) - 1;
        if (left > 0) this.calls.set(tabId, left);
        else this.calls.delete(tabId);
        if (this.pages.has(tabId)) this.shownAt.set(tabId, this.now());
      },
    };
  }

  /** The window stopped holding its workspace or closed: its pages go with it. */
  public dropWindow(window: BrowserWindow): void {
    this.visible.delete(window);
    for (const [tabId, owner] of [...this.pages]) if (owner === window) this.drop(tabId);
  }

  /**
   * Applies the rule and returns the tabs it unloaded, already removed from
   * the set. A tab `exists` no longer is dropped without being returned.
   */
  public evaluate(exists: (tabId: string) => boolean): string[] {
    const now = this.now();
    const shown = new Set(this.visible.values());
    for (const tabId of shown) if (this.pages.has(tabId)) this.shownAt.set(tabId, now);

    const candidates = [];
    for (const tabId of [...this.pages.keys()]) {
      if (!exists(tabId)) {
        this.drop(tabId);
        continue;
      }
      candidates.push({
        id: tabId,
        lastShownAt: this.shownAt.get(tabId) ?? now,
        visible: shown.has(tabId),
        toolCallInFlight: (this.calls.get(tabId) ?? 0) > 0,
      });
    }
    const keep = decideLive(candidates, now);
    const unloaded = candidates.filter((c) => !keep.has(c.id)).map((c) => c.id);
    for (const tabId of unloaded) this.drop(tabId);
    return unloaded;
  }

  public clear(): void {
    this.pages.clear();
    this.shownAt.clear();
    this.visible.clear();
    this.calls.clear();
  }
}
