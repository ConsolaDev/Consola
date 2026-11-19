import { randomUUID } from 'node:crypto';
import type { BrowserWindow, WebContents } from 'electron';
import {
  isAllowedPageUrl,
  MAX_TABS_PER_SESSION,
  type BrowserSessionSnapshot,
  type BrowserTab,
  type BrowserTabError,
  type BrowserTabLive,
  type SessionBrowser,
} from '../../shared/browser';
import { IPC_CHANNELS } from '../../shared/constants';
import type { BrowserStateStore } from './BrowserStateStore';

/** A guest whose renderer dies is reloaded at most this often before the person decides. */
export const CRASH_RETRY_LIMIT = 3;
export const CRASH_RETRY_WINDOW_MS = 30_000;

/** What a window receives on `BROWSER_SNAPSHOT`: one session's tabs, merged with live state. */
export interface BrowserSnapshotMessage {
  sessionId: string;
  snapshot: BrowserSessionSnapshot;
}

export interface BrowserServiceDeps {
  store: BrowserStateStore;
  /** The workspace a session belongs to, or undefined when it no longer exists. */
  workspaceIdForSession(sessionId: string): string | undefined;
  /** The window currently holding a workspace; at most one does. */
  findWindowForWorkspace(workspaceId: string): BrowserWindow | undefined;
  send(window: BrowserWindow, channel: string, payload: BrowserSnapshotMessage): void;
  /** Wipes a workspace's cookies, storage and cache (its partition). */
  clearPartition(workspaceId: string): Promise<void> | void;
  now?(): number;
  newId?(): string;
}

/** What one live guest needs remembered beside the tab. */
interface LiveGuest {
  guest: WebContents;
  /** Read once up front: `webContents.id` throws once the contents is destroyed. */
  guestId: number;
  host: BrowserWindow;
  /** When this guest's renderer died recently, for the retry budget. */
  crashes: number[];
  unsubscribe(): void;
}

type LiveFields = Pick<
  BrowserTabLive,
  'loading' | 'canGoBack' | 'canGoForward' | 'error' | 'favicon'
>;

const IDLE: LiveFields = { loading: false, canGoBack: false, canGoForward: false };

/**
 * The in-app browser's tabs and the guests behind them.
 *
 * Main owns the tab list: a window only ever sees snapshots, and a tab
 * survives its guest, since hidden pages unload and a window can close while
 * the session lives on. The persisted record (`BrowserTab`) holds only what
 * must outlive a launch; everything else (`LiveFields`, whether a guest
 * exists) is rebuilt from the guest's own events and never written.
 *
 * Free of `ipcMain` on purpose: handlers check the sender and ownership
 * (`tabBelongsToWorkspace`), then call in. Every change pushes a fresh
 * snapshot of that one session to the one window holding its workspace.
 *
 * Tool-call bookkeeping (`agentActive`) and the live-page policy belong on
 * top of this and are not here yet; `snapshotFor` reports them as idle.
 */
export class BrowserService {
  private readonly guests = new Map<string, LiveGuest>();
  private readonly live = new Map<string, LiveFields>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: BrowserServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  // --- Tabs ---

  public listFor(sessionId: string): BrowserTab[] {
    return this.deps.store.getSession(sessionId)?.tabs ?? [];
  }

  /**
   * Opens a tab and makes it the one showing. An empty address is a tab for
   * the address bar to fill. Null when the session is unknown, the address is
   * not a web page, or the session is at its cap.
   */
  public openTab(
    sessionId: string,
    url: string,
    openedBy: BrowserTab['openedBy'],
  ): BrowserTab | null {
    if (!this.deps.workspaceIdForSession(sessionId)) return null;
    if (url !== '' && !isAllowedPageUrl(url)) return null;
    const session = this.deps.store.getSession(sessionId) ?? { tabs: [], activeTabId: null };
    if (session.tabs.length >= MAX_TABS_PER_SESSION) return null;

    const tab: BrowserTab = { id: this.newId(), url, title: '', openedBy };
    this.deps.store.setSession(sessionId, { tabs: [...session.tabs, tab], activeTabId: tab.id });
    this.pushSnapshot(sessionId);
    return tab;
  }

  public closeTab(tabId: string): void {
    const found = this.find(tabId);
    if (!found) return;
    const { sessionId, session } = found;
    const index = session.tabs.findIndex((t) => t.id === tabId);
    const tabs = session.tabs.filter((t) => t.id !== tabId);
    // Closing the visible tab shows its neighbour, as a browser does.
    const activeTabId =
      session.activeTabId === tabId
        ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
        : session.activeTabId;
    this.destroyGuest(tabId);
    this.live.delete(tabId);
    this.deps.store.setSession(sessionId, { tabs, activeTabId });
    this.pushSnapshot(sessionId);
  }

  public activateTab(tabId: string): void {
    const found = this.find(tabId);
    if (!found || found.session.activeTabId === tabId) return;
    this.deps.store.setSession(found.sessionId, { ...found.session, activeTabId: tabId });
    this.pushSnapshot(found.sessionId);
  }

  /**
   * Sends a tab to an address. False when the address is not a web page.
   * A tab with no guest only records the address: the guest that mounts for
   * it starts there.
   */
  public navigate(tabId: string, url: string): boolean {
    if (!isAllowedPageUrl(url)) return false;
    const found = this.find(tabId);
    if (!found) return false;
    const guest = this.liveGuest(tabId);
    if (guest) {
      // A failed load arrives as `did-fail-load`; the rejection adds nothing.
      void guest.loadURL(url).catch(() => {});
    } else {
      this.updateTab(tabId, { url });
    }
    return true;
  }

  /** The page committed an address: remember it, and the visit. */
  public recordCommit(tabId: string, url: string, title: string): void {
    const found = this.find(tabId);
    if (!found) return;
    // A failed load commits Chromium's error page, and Electron reports it as a
    // navigation. It is neither the page's address nor a visit, and it must not
    // wipe the error that explains it; `did-start-loading` clears errors.
    if (this.live.get(tabId)?.error?.kind === 'unreachable') return;
    if (!isAllowedPageUrl(url)) return;
    this.updateTab(tabId, { url, title });
    const workspaceId = this.deps.workspaceIdForSession(found.sessionId);
    if (workspaceId && isAllowedPageUrl(url)) {
      this.deps.store.addHistory(workspaceId, { url, title, at: this.now() });
    }
  }

  public tabBelongsToWorkspace(tabId: string, workspaceId: string): boolean {
    const found = this.find(tabId);
    return !!found && this.deps.workspaceIdForSession(found.sessionId) === workspaceId;
  }

  // --- Guest actions ---

  public goBack(tabId: string): void {
    const guest = this.liveGuest(tabId);
    if (guest?.navigationHistory.canGoBack()) guest.navigationHistory.goBack();
  }

  public goForward(tabId: string): void {
    const guest = this.liveGuest(tabId);
    if (guest?.navigationHistory.canGoForward()) guest.navigationHistory.goForward();
  }

  public reload(tabId: string): void {
    this.liveGuest(tabId)?.reload();
  }

  public stop(tabId: string): void {
    this.liveGuest(tabId)?.stop();
  }

  // --- Live guests ---

  /** The bound guest, for callers that act on the page itself. */
  public guestFor(tabId: string): WebContents | undefined {
    return this.liveGuest(tabId);
  }

  /**
   * Binds a mounted guest to its tab and follows its events. The caller has
   * already checked what the guest is and whom it belongs to; here only the
   * tab must exist. A guest already bound to the tab is let go, not closed:
   * the renderer owns its element.
   */
  public bindGuest(tabId: string, guest: WebContents, host: BrowserWindow): boolean {
    const found = this.find(tabId);
    if (!found) return false;
    this.unbindGuest(tabId);

    const entry: LiveGuest = { guest, guestId: guest.id, host, crashes: [], unsubscribe: () => {} };
    const listeners = this.listenersFor(tabId, entry);
    for (const [event, listener] of listeners) guest.on(event as 'destroyed', listener);
    entry.unsubscribe = () => {
      for (const [event, listener] of listeners)
        guest.removeListener(event as 'destroyed', listener);
    };
    this.guests.set(tabId, entry);
    this.setLive(tabId, this.readNavigationState(guest), false);
    this.pushSnapshot(found.sessionId);
    return true;
  }

  /** Stops following a guest without closing it. */
  public unbindGuest(tabId: string, push = true): void {
    const entry = this.guests.get(tabId);
    if (!entry) return;
    entry.unsubscribe();
    this.guests.delete(tabId);
    this.live.set(tabId, { ...IDLE });
    const found = this.find(tabId);
    if (found && push) this.pushSnapshot(found.sessionId);
  }

  // --- Snapshots ---

  public snapshotFor(sessionId: string): BrowserSessionSnapshot {
    const session = this.deps.store.getSession(sessionId);
    if (!session) return { tabs: [], activeTabId: null };
    return {
      tabs: session.tabs.map((tab) => ({
        ...tab,
        ...IDLE,
        ...this.live.get(tab.id),
        live: this.guests.has(tab.id),
        agentActive: false,
      })),
      activeTabId: session.activeTabId,
    };
  }

  // --- Lifecycle ---

  /** The session is gone: its tabs and pages go with it. */
  public destroySession(sessionId: string): void {
    const session = this.deps.store.getSession(sessionId);
    if (!session) return;
    for (const tab of session.tabs) {
      this.destroyGuest(tab.id);
      this.live.delete(tab.id);
    }
    this.deps.store.deleteSession(sessionId);
  }

  /**
   * The workspace is gone: every tab of its sessions, its history and its
   * logins. Call it while the workspace is still known, since the sessions
   * are found through it.
   */
  public destroyWorkspace(workspaceId: string): void {
    for (const sessionId of this.deps.store.sessionIds()) {
      if (this.deps.workspaceIdForSession(sessionId) === workspaceId)
        this.destroySession(sessionId);
    }
    this.deps.store.deleteHistory(workspaceId);
    void Promise.resolve(this.deps.clearPartition(workspaceId)).catch(() => {});
  }

  /** The window stopped holding its workspace or closed: its pages go, the tabs stay. */
  public detachWindow(window: BrowserWindow): void {
    for (const [tabId, entry] of [...this.guests]) {
      if (entry.host === window) this.unbindGuest(tabId, false);
    }
  }

  /** App quit: the guests die with their windows, so only the state needs saving. */
  public destroyAll(): void {
    for (const tabId of [...this.guests.keys()]) this.destroyGuest(tabId);
    this.live.clear();
    this.deps.store.flush();
  }

  // --- Internals ---

  private find(
    tabId: string,
  ): { sessionId: string; session: SessionBrowser; tab: BrowserTab } | undefined {
    for (const sessionId of this.deps.store.sessionIds()) {
      const session = this.deps.store.getSession(sessionId);
      const tab = session?.tabs.find((t) => t.id === tabId);
      if (session && tab) return { sessionId, session, tab };
    }
    return undefined;
  }

  private liveGuest(tabId: string): WebContents | undefined {
    const guest = this.guests.get(tabId)?.guest;
    return guest && !guest.isDestroyed() ? guest : undefined;
  }

  /** Ends a guest's page for good; its `destroyed` event then finds nothing to unbind. */
  private destroyGuest(tabId: string): void {
    const entry = this.guests.get(tabId);
    if (!entry) return;
    entry.unsubscribe();
    this.guests.delete(tabId);
    if (!entry.guest.isDestroyed()) entry.guest.close();
  }

  private updateTab(tabId: string, fields: Partial<Pick<BrowserTab, 'url' | 'title'>>): void {
    const found = this.find(tabId);
    if (!found) return;
    const tabs = found.session.tabs.map((t) => (t.id === tabId ? { ...t, ...fields } : t));
    this.deps.store.setSession(found.sessionId, { ...found.session, tabs });
    this.pushSnapshot(found.sessionId);
  }

  private setLive(tabId: string, fields: Partial<LiveFields>, push = true): void {
    this.live.set(tabId, { ...IDLE, ...this.live.get(tabId), ...fields });
    if (!push) return;
    const found = this.find(tabId);
    if (found) this.pushSnapshot(found.sessionId);
  }

  private readNavigationState(guest: WebContents): Pick<LiveFields, 'canGoBack' | 'canGoForward'> {
    return {
      canGoBack: guest.navigationHistory.canGoBack(),
      canGoForward: guest.navigationHistory.canGoForward(),
    };
  }

  private pushSnapshot(sessionId: string): void {
    const workspaceId = this.deps.workspaceIdForSession(sessionId);
    const window = workspaceId ? this.deps.findWindowForWorkspace(workspaceId) : undefined;
    // A window that is closing may still be reported by its `closed` handler;
    // sending to a destroyed one throws.
    if (!window || window.isDestroyed?.() || window.webContents?.isDestroyed?.()) return;
    this.deps.send(window, IPC_CHANNELS.BROWSER_SNAPSHOT, {
      sessionId,
      snapshot: this.snapshotFor(sessionId),
    });
  }

  private listenersFor(
    tabId: string,
    entry: LiveGuest,
  ): Array<[string, (...args: never[]) => void]> {
    const { guest } = entry;
    const commit = (url: string) => {
      this.recordCommit(tabId, url, guest.getTitle());
      this.setLive(tabId, this.readNavigationState(guest));
    };
    const onFailLoad = (
      _event: unknown,
      code: number,
      description: string,
      url: string,
      isMainFrame: boolean,
    ) => {
      // -3 is a load another navigation superseded, not a failure.
      if (!isMainFrame || code === -3) return;
      const error: BrowserTabError = { kind: 'unreachable', code, description, url };
      this.setLive(tabId, { error, loading: false });
    };
    const onCrash = (_event: unknown, details: { reason?: string }) => {
      if (details?.reason === 'clean-exit') return;
      this.setLive(tabId, { error: { kind: 'crashed' }, loading: false });
      const at = this.now();
      entry.crashes = entry.crashes.filter((t) => at - t < CRASH_RETRY_WINDOW_MS);
      // Past the budget the crash stays on screen: a page that dies every
      // time is not helped by another reload.
      if (entry.crashes.length >= CRASH_RETRY_LIMIT) return;
      entry.crashes.push(at);
      if (!guest.isDestroyed()) guest.reload();
    };

    return [
      ['did-navigate', (_e: unknown, url: string) => commit(url)],
      [
        'did-navigate-in-page',
        (_e: unknown, url: string, isMainFrame: boolean) => {
          if (isMainFrame) commit(url);
        },
      ],
      ['page-title-updated', (_e: unknown, title: string) => this.updateTab(tabId, { title })],
      ['did-start-loading', () => this.setLive(tabId, { loading: true, error: null })],
      ['did-stop-loading', () => this.setLive(tabId, { loading: false })],
      ['did-fail-load', onFailLoad],
      ['render-process-gone', onCrash],
      ['destroyed', () => this.unbindGuest(tabId)],
    ] as Array<[string, (...args: never[]) => void]>;
  }
}
