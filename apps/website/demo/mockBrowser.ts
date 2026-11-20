// The in-app browser's stand-in. A web page cannot host Electron's `<webview>`,
// so no page ever loads in the demo: it behaves like the desktop app with every
// page unloaded. Each session's tabs and each workspace's visited pages are held
// in memory, the way main holds them, and every change is pushed the way main
// pushes it, so the tab strip, the address bar and the empty tab respond. What
// needs a live page (reload, find, zoom, capture, DevTools, a sign-in) does what
// main does for a tab with none: nothing.
import {
  MAX_HISTORY_PER_WORKSPACE,
  MAX_TABS_PER_SESSION,
  isAllowedPageUrl,
  isBlankPageUrl,
  isLoopbackHost,
  type BrowserAPI,
  type BrowserHistoryEntry,
  type BrowserSessionSnapshot,
  type BrowserSnapshotMessage,
  type SessionBrowser,
} from '../../desktop/src/shared/browser';

export interface BrowserMockDeps {
  /** The mock's channel for pushed snapshots. */
  snapshots: {
    subscribe: BrowserAPI['onSnapshot'];
    emit: (message: BrowserSnapshotMessage) => void;
  };
  /** The workspace a session belongs to; undefined for one the demo does not hold. */
  workspaceOf: (sessionId: string) => string | undefined;
  /** The workspace the demo's window shows: the one `history` and `clearData` are about. */
  windowWorkspace: () => string | null;
  notify: (message: string) => void;
}

const noSubscription = () => () => {};

export function browserMock({
  snapshots,
  workspaceOf,
  windowWorkspace,
  notify,
}: BrowserMockDeps): BrowserAPI {
  const sessions = new Map<string, SessionBrowser>();
  const history = new Map<string, BrowserHistoryEntry[]>();
  let sequence = 0;

  /** Every tab as main reports one with no page: not live, not loading, nowhere to go back to. */
  function snapshot(sessionId: string): BrowserSessionSnapshot {
    const browser = sessions.get(sessionId);
    return {
      tabs: (browser?.tabs ?? []).map((tab) => ({
        ...tab,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        live: false,
        loadId: 0,
        agentActive: false,
      })),
      activeTabId: browser?.activeTabId ?? null,
    };
  }
  function save(sessionId: string, browser: SessionBrowser) {
    sessions.set(sessionId, browser);
    snapshots.emit({ sessionId, snapshot: snapshot(sessionId) });
  }
  function find(tabId: string) {
    for (const [sessionId, browser] of sessions) {
      const tab = browser.tabs.find((t) => t.id === tabId);
      if (tab) return { sessionId, browser, tab };
    }
    return undefined;
  }
  /**
   * Sends a tab to a web address, as main does for a tab with no page: the
   * tab's address is all that changes. The tab's session, or undefined when
   * there is no such tab or the address is not a web page.
   */
  function move(tabId: string, url: string) {
    const found = find(tabId);
    if (!found || !isAllowedPageUrl(url)) return undefined;
    const tabs = found.browser.tabs.map((t) => (t.id === tabId ? { ...t, url } : t));
    save(found.sessionId, { ...found.browser, tabs });
    return found.sessionId;
  }
  /**
   * Main records a visit when a page commits. None ever does here, so the
   * address the session was sent to is the visit, and the notice says why the
   * page stays empty.
   */
  function visit(sessionId: string, url: string) {
    notify('Pages load beside the session in the desktop app. This demo keeps the tab only.');
    const workspaceId = workspaceOf(sessionId);
    if (!workspaceId) return;
    const current = history.get(workspaceId) || [];
    const rest = current[0]?.url === url ? current.slice(1) : current;
    history.set(
      workspaceId,
      [{ url, title: '', at: Date.now() }, ...rest].slice(0, MAX_HISTORY_PER_WORKSPACE),
    );
  }

  return {
    get: async (sessionId) => snapshot(sessionId),
    open: async (sessionId, url) => {
      if (!workspaceOf(sessionId)) return null;
      if (url !== '' && !isAllowedPageUrl(url)) return null;
      const browser = sessions.get(sessionId) || { tabs: [], activeTabId: null };
      if (browser.tabs.length >= MAX_TABS_PER_SESSION) return null;
      const tab = { id: `demo-tab-${++sequence}`, url, title: '', openedBy: 'person' as const };
      save(sessionId, { tabs: [...browser.tabs, tab], activeTabId: tab.id });
      if (!isBlankPageUrl(url)) visit(sessionId, url);
      return structuredClone(tab);
    },
    close: async (tabId) => {
      const found = find(tabId);
      if (!found) return;
      const { sessionId, browser } = found;
      const index = browser.tabs.findIndex((t) => t.id === tabId);
      const tabs = browser.tabs.filter((t) => t.id !== tabId);
      // Closing the tab showing shows its neighbour, as main does.
      const activeTabId =
        browser.activeTabId === tabId
          ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
          : browser.activeTabId;
      save(sessionId, { tabs, activeTabId });
    },
    activate: async (tabId) => {
      const found = find(tabId);
      if (!found || found.browser.activeTabId === tabId) return;
      save(found.sessionId, { ...found.browser, activeTabId: tabId });
    },
    navigate: async (tabId, url) => {
      const sessionId = move(tabId, url);
      if (!sessionId) return false;
      visit(sessionId, url);
      return true;
    },
    // The window's own retry of an unreachable page on this machine. A timer,
    // not the person, so it moves the tab and nothing else: no visit and no
    // notice. Only a loopback address is retried, as main allows. No demo page
    // is ever unreachable, so nothing here calls it.
    retry: async (tabId, url) => {
      if (!isAllowedPageUrl(url) || !isLoopbackHost(new URL(url).hostname)) return false;
      return move(tabId, url) !== undefined;
    },
    back: async () => {},
    forward: async () => {},
    reload: async () => {},
    stop: async () => {},
    hardReload: async () => {},
    find: async () => {},
    stopFind: async () => {},
    // 0 is 100%: there is no page to zoom.
    zoom: async () => 0,
    openDevTools: async () => {},
    history: async () => structuredClone(history.get(windowWorkspace() || '') || []),
    // Nothing in the demo starts a server.
    localServers: async () => [],
    capture: async () => null,
    continueCertificate: async () => false,
    answerAuth: async () => {},
    // There are no cookies or certificates to clear; the tabs stay, as in the app.
    clearData: async () => {
      history.delete(windowWorkspace() || '');
    },
    // No `<webview>` is ever mounted here, so there is nothing to bind.
    attach: async () => false,
    setVisible: async () => {},
    onSnapshot: snapshots.subscribe,
    onShortcut: noSubscription,
    onFound: noSubscription,
    onAuthRequest: noSubscription,
    onAuthCancelled: noSubscription,
  };
}
