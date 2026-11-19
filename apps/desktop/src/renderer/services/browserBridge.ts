import type {
  BrowserSessionSnapshot,
  BrowserShortcutMessage,
  BrowserSnapshotMessage,
  BrowserTab,
} from '../../shared/browser';

/**
 * Bridge to the in-app browser owned by the main process. The only renderer
 * access to `window.browserAPI`.
 *
 * Main owns the tabs; a window only sees snapshots. Every call names a
 * session or tab of this window's workspace, and main refuses any other.
 *
 * Navigation goes through `navigate` and nowhere else: never set a
 * `<webview>`'s `src` after attach, or the address bypasses main's checks and
 * the tab's record.
 */
export const browserBridge = {
  /** One session's tabs with their live state, for the first paint. */
  get(sessionId: string): Promise<BrowserSessionSnapshot> {
    return window.browserAPI.get(sessionId);
  },

  /** Open a tab and make it the active one. An empty `url` opens a blank tab; null means refused. */
  open(sessionId: string, url: string): Promise<BrowserTab | null> {
    return window.browserAPI.open(sessionId, url);
  },

  close(tabId: string): Promise<void> {
    return window.browserAPI.close(tabId);
  },

  activate(tabId: string): Promise<void> {
    return window.browserAPI.activate(tabId);
  },

  /** Send a tab to a web address. False when it is not one. */
  navigate(tabId: string, url: string): Promise<boolean> {
    return window.browserAPI.navigate(tabId, url);
  },

  back(tabId: string): Promise<void> {
    return window.browserAPI.back(tabId);
  },

  forward(tabId: string): Promise<void> {
    return window.browserAPI.forward(tabId);
  },

  reload(tabId: string): Promise<void> {
    return window.browserAPI.reload(tabId);
  },

  stop(tabId: string): Promise<void> {
    return window.browserAPI.stop(tabId);
  },

  /**
   * Bind a mounted `<webview>` to its tab, once its page exists (`did-attach`),
   * with its `getWebContentsId()`. Resolves false when main refused it.
   */
  attach(tabId: string, webContentsId: number): Promise<boolean> {
    return window.browserAPI.attach(tabId, webContentsId);
  },

  /**
   * Tell main which tab the person is looking at, or none (null both): the
   * panel is closed, an overlay covers it, or the window left the workspace.
   * Main keeps that page live and may unload the others.
   */
  setVisible(sessionId: string | null, tabId: string | null): Promise<void> {
    return window.browserAPI.setVisible(sessionId, tabId);
  },

  /** A session's snapshot changed. Returns the unsubscribe. */
  onSnapshot(callback: (message: BrowserSnapshotMessage) => void): () => void {
    return window.browserAPI.onSnapshot(callback);
  },

  /** A chord was pressed while a page had focus, and main took it. Returns the unsubscribe. */
  onShortcut(callback: (message: BrowserShortcutMessage) => void): () => void {
    return window.browserAPI.onShortcut(callback);
  },
};
