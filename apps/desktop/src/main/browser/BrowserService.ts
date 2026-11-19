import { randomUUID } from 'node:crypto';
import type { BrowserWindow, WebContents } from 'electron';
import {
  isAllowedPageUrl,
  MAX_TABS_PER_SESSION,
  type BrowserSessionSnapshot,
  type BrowserSnapshotMessage,
  type BrowserTab,
  type BrowserTabError,
  type BrowserTabLive,
  type SessionBrowser,
} from '../../shared/browser';
import { IPC_CHANNELS } from '../../shared/constants';
import type { BrowserStateStore } from './BrowserStateStore';
import { PopupRegistry } from './popupWindows';

/** A guest whose renderer dies is reloaded at most this often before the person decides. */
export const CRASH_RETRY_LIMIT = 3;
export const CRASH_RETRY_WINDOW_MS = 30_000;

export type { BrowserSnapshotMessage };

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

/** How long an attached guest is remembered while nothing claims it. */
export const PENDING_GUEST_MS = 30_000;

/** What a guest did between attaching and being bound to its tab. */
interface PendingGuest {
  loading: boolean;
  error: BrowserTabError | null;
  /** The last committed address seen. */
  url: string | undefined;
  stop(): void;
}

/** What one live guest needs remembered beside the tab. */
interface LiveGuest {
  guest: WebContents;
  /** Read once up front: `webContents.id` throws once the contents is destroyed. */
  guestId: number;
  /**
   * Remembered so the guest can be ended when the store no longer has the
   * tab: a workspace delete prunes the store before the browser is told.
   */
  sessionId: string;
  workspaceId: string | undefined;
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
  /** Guests attached but not yet bound, by guest id. */
  private readonly pending = new Map<number, PendingGuest>();
  /** The popup windows pages opened, closed with whatever owns them. */
  public readonly popups = new PopupRegistry();
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

    const entry: LiveGuest = {
      guest,
      guestId: guest.id,
      sessionId: found.sessionId,
      workspaceId: this.deps.workspaceIdForSession(found.sessionId),
      host,
      crashes: [],
      unsubscribe: () => {},
    };
    const listeners = this.listenersFor(tabId, entry);
    for (const [event, listener] of listeners) guest.on(event as 'destroyed', listener);
    entry.unsubscribe = () => {
      for (const [event, listener] of listeners)
        guest.removeListener(event as 'destroyed', listener);
    };
    this.guests.set(tabId, entry);

    // What happened before this bind: the first load may be under way, have
    // redirected, or have failed already.
    const claimed = this.pending.get(guest.id);
    this.dropPending(guest.id);
    const loading = guest.isLoading();
    const error = loading ? null : (claimed?.error ?? null);
    if (!error) {
      const url = [guest.getURL(), claimed?.url].find((u) => u && isAllowedPageUrl(u));
      if (url) this.recordCommit(tabId, url, guest.getTitle());
    }
    this.setLive(tabId, { ...this.readNavigationState(guest), loading, error }, false);
    this.pushSnapshot(found.sessionId);
    return true;
  }

  /** Stops following a guest without closing it. */
  public unbindGuest(tabId: string, push = true): void {
    const entry = this.guests.get(tabId);
    if (!entry) return;
    entry.unsubscribe();
    this.guests.delete(tabId);
    const found = this.find(tabId);
    // A late event for a tab already removed must not bring its entry back.
    if (found) this.live.set(tabId, { ...IDLE });
    else this.live.delete(tabId);
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
    // By the guests' own memory as well as the store's tabs: the store may
    // already have dropped the session (see `prune`).
    this.destroyGuestsWhere((entry) => entry.sessionId === sessionId);
    this.popups.closeWhere((owner) => owner.sessionId === sessionId);
    const session = this.deps.store.getSession(sessionId);
    if (!session) return;
    for (const tab of session.tabs) this.live.delete(tab.id);
    this.deps.store.deleteSession(sessionId);
  }

  /**
   * Housekeeping after sessions or workspaces were deleted: their pages are
   * closed and their live state dropped before the store forgets them, since
   * the store alone cannot reach a guest.
   */
  public prune(liveSessionIds: Set<string>, liveWorkspaceIds: Set<string>): void {
    for (const sessionId of this.deps.store.sessionIds()) {
      if (!liveSessionIds.has(sessionId)) this.destroySession(sessionId);
    }
    this.destroyGuestsWhere((entry) => !liveSessionIds.has(entry.sessionId));
    this.popups.closeWhere((owner) => !liveSessionIds.has(owner.sessionId));
    this.deps.store.prune(liveSessionIds, liveWorkspaceIds);
  }

  /**
   * The workspace is gone: every tab of its sessions, its history and its
   * logins. The caller names the sessions it read before deleting the record,
   * so this runs only once the delete has succeeded.
   */
  public destroyWorkspace(workspaceId: string, sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) this.destroySession(sessionId);
    // Every page of the workspace is closed before its storage is cleared: a
    // live page could otherwise write it again afterwards.
    this.destroyGuestsWhere((entry) => entry.workspaceId === workspaceId);
    this.popups.closeWhere((owner) => owner.workspaceId === workspaceId);
    this.deps.store.deleteHistory(workspaceId);
    void Promise.resolve(this.deps.clearPartition(workspaceId)).catch(() => {});
  }

  /** The window stopped holding its workspace or closed: its pages go, the tabs stay. */
  public detachWindow(window: BrowserWindow): void {
    for (const [tabId, entry] of [...this.guests]) {
      if (entry.host === window) this.unbindGuest(tabId, false);
    }
    this.popups.closeWhere((owner) => owner.host === window);
  }

  /** App quit: the guests die with their windows, so only the state needs saving. */
  public destroyAll(): void {
    for (const tabId of [...this.guests.keys()]) this.destroyGuest(tabId);
    this.popups.closeAll();
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

  /**
   * The tab a guest is bound to, or null while it is not (a page's first keys
   * can arrive before the renderer binds it). Asked by guest id, never by the
   * contents: a destroyed one throws on `.id`.
   */
  public tabIdForGuest(guestId: number): string | null {
    for (const [tabId, entry] of this.guests) if (entry.guestId === guestId) return tabId;
    return null;
  }

  /** The session whose tab a guest is bound to, or undefined while it is not. */
  public sessionIdForGuest(guestId: number): string | undefined {
    for (const entry of this.guests.values()) if (entry.guestId === guestId) return entry.sessionId;
    return undefined;
  }

  /** Whether a session may not open another tab. */
  public atTabCap(sessionId: string): boolean {
    return this.listFor(sessionId).length >= MAX_TABS_PER_SESSION;
  }

  private liveGuest(tabId: string): WebContents | undefined {
    const guest = this.guests.get(tabId)?.guest;
    return guest && !guest.isDestroyed() ? guest : undefined;
  }

  private destroyGuestsWhere(match: (entry: LiveGuest) => boolean): void {
    for (const [tabId, entry] of [...this.guests]) {
      if (!match(entry)) continue;
      this.destroyGuest(tabId);
      this.live.delete(tabId);
    }
  }

  /**
   * Lets go of a guest and silences its page. Never `close()`: on a loaded
   * `<webview>` guest that only destroys main's handle while the page keeps
   * running (and a `window.open` from it then crashes main). Removing the
   * element in the renderer is what tears it down cleanly, driven by the
   * snapshots; until it does, the page is blanked so nothing keeps loading or
   * writing storage.
   */
  private destroyGuest(tabId: string): void {
    const entry = this.guests.get(tabId);
    if (!entry) return;
    entry.unsubscribe();
    this.guests.delete(tabId);
    const { guest } = entry;
    if (guest.isDestroyed()) return;
    try {
      guest.stop();
      guest.loadURL('about:blank').catch(() => undefined);
    } catch {
      // The guest died between the check and the call: nothing left to stop.
    }
  }

  // --- A page's first load ---

  /**
   * Starts remembering what a just-attached guest does. The renderer binds a
   * guest only after `dom-ready`, by which time its first load may already
   * have started, redirected or failed; `bindGuest` claims this record so the
   * tab shows that rather than a quiet page.
   */
  public noteAttached(guest: WebContents, guestId: number): void {
    this.dropPending(guestId);
    const pending: PendingGuest = { loading: false, error: null, url: undefined, stop: () => {} };
    const onFail = (
      _event: unknown,
      code: number,
      description: string,
      url: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || code === -3) return;
      pending.error = { kind: 'unreachable', code, description, url };
      pending.loading = false;
    };
    const listeners: Array<[string, (...args: never[]) => void]> = [
      [
        'did-start-loading',
        () => {
          pending.loading = true;
          pending.error = null;
        },
      ],
      ['did-stop-loading', () => (pending.loading = false)],
      ['did-fail-load', onFail],
      ['did-navigate', (_e: unknown, url: string) => (pending.url = url)],
      ['destroyed', () => this.dropPending(guestId)],
    ] as Array<[string, (...args: never[]) => void]>;
    for (const [event, listener] of listeners) guest.on(event as 'destroyed', listener);
    const timer = setTimeout(() => this.dropPending(guestId), PENDING_GUEST_MS);
    timer.unref?.();
    pending.stop = () => {
      clearTimeout(timer);
      for (const [event, listener] of listeners)
        guest.removeListener(event as 'destroyed', listener);
    };
    this.pending.set(guestId, pending);
  }

  private dropPending(guestId: number): void {
    this.pending.get(guestId)?.stop();
    this.pending.delete(guestId);
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
