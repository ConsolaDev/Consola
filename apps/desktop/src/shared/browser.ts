/**
 * The in-app browser's shared vocabulary: what is persisted, what is live,
 * and the pure rules for addresses and links. No IO and no Node or DOM
 * imports, because main, the renderer and tests all read it.
 */

import type { FindResult, ZoomStep } from './browserTools';
import type { ForwardedShortcut } from './shortcuts';

/** A session can hold this many pages; more would keep too many guests alive. */
export const MAX_TABS_PER_SESSION = 12;

/** Recently visited pages remembered per workspace, for address suggestions. */
export const MAX_HISTORY_PER_WORKSPACE = 50;

export const BROWSER_PARTITION_PREFIX = 'persist:consola-browser-';

/**
 * One persistent partition per workspace: cookies and logins are shared by
 * its sessions, and never by another workspace. The renderer needs the same
 * string for the `<webview partition>` attribute that main's guest policy
 * checks, so both build it here.
 */
export function browserPartitionFor(workspaceId: string): string {
  return `${BROWSER_PARTITION_PREFIX}${workspaceId}`;
}

// --- Persisted state (browser-state.json) ---

export interface BrowserTab {
  id: string;
  /** The last committed address. */
  url: string;
  title: string;
  /** Who opened the page: an agent's page is flagged until the person looks. */
  openedBy: 'person' | 'agent';
}

export interface SessionBrowser {
  /** At most `MAX_TABS_PER_SESSION`. */
  tabs: BrowserTab[];
  activeTabId: string | null;
}

export interface BrowserHistoryEntry {
  url: string;
  title: string;
  /** Epoch milliseconds of the visit. */
  at: number;
}

export interface BrowserStateFile {
  /** By session id. */
  sessions: Record<string, SessionBrowser>;
  /** By workspace id, at most `MAX_HISTORY_PER_WORKSPACE` each. */
  history: Record<string, BrowserHistoryEntry[]>;
}

// --- Live state (never persisted) ---

export type BrowserTabError =
  /** The page could not be reached (DNS, refused connection, timeout). */
  | { kind: 'unreachable'; code: number; description: string; url: string }
  /** The server's certificate was refused; the person decides what to do. */
  | {
      kind: 'certificate';
      url: string;
      host: string;
      error: string;
      /** Whether "Continue anyway" is on offer: only an unknown authority on this machine. */
      canContinue: boolean;
    }
  /** The guest's renderer process died. */
  | { kind: 'crashed' };

export interface BrowserTabLive {
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Absent while the page is fine. */
  error?: BrowserTabError | null;
  favicon?: string;
  /**
   * Whether the window should have a page for this tab. Main decides: a tab
   * is live once shown, and unloaded after a while hidden or past the cap.
   */
  live: boolean;
  /**
   * Which load of the page this is: main gives a tab a new one each time it
   * becomes live. A window keys the page's element by it, so a tab that was
   * unloaded and shown again is a new element even if the window never saw
   * the tab as not live in between.
   */
  loadId: number;
  /** An agent is driving this tab right now. */
  agentActive: boolean;
}

/** A tab as a window sees it: the persisted record merged with its live state. */
export type BrowserTabSnapshot = BrowserTab & BrowserTabLive;

/** What main pushes to a window for one session. */
export interface BrowserSessionSnapshot {
  tabs: BrowserTabSnapshot[];
  activeTabId: string | null;
}

/** A server listening on this machine, started from a session's folder. */
export interface LocalServer {
  port: number;
  /** The process's command name, as `lsof` reports it (it may be truncated). */
  command: string;
  /** Where to open it. */
  url: string;
}

/** What a window receives on `BROWSER_SNAPSHOT`: one session's tabs, merged with live state. */
export interface BrowserSnapshotMessage {
  sessionId: string;
  snapshot: BrowserSessionSnapshot;
}

/**
 * What a window receives on `BROWSER_SHORTCUT`: a chord main took from a page
 * that had focus. `tabId` is the tab whose page it came from, or null when
 * main had not bound that page to a tab yet.
 */
export interface BrowserShortcutMessage {
  tabId: string | null;
  action: ForwardedShortcut;
}

/**
 * What a window receives on `BROWSER_FOUND`: a tab's current find result, or
 * null when its search ended (the page navigated or went away).
 */
export interface BrowserFoundMessage {
  tabId: string;
  result: FindResult | null;
}

/** What a window receives on `BROWSER_AUTH_REQUEST`: a page asks the person to sign in. */
export interface BrowserAuthRequestMessage {
  /** Names the request when the window answers; main checks the answer came from this window. */
  id: string;
  /**
   * The tab asking; null while its page is not bound to one yet. The window
   * draws the prompt over that tab's page, and only while the tab is shown.
   */
  tabId: string | null;
  /** The page's own origin: the dialog says who is asking. */
  origin: string;
  /** The server's name for what is protected; page-controlled text, shown as such. */
  realm: string;
}

/** What a window receives on `BROWSER_AUTH_CANCELLED`: the request ended without an answer. */
export interface BrowserAuthCancelledMessage {
  id: string;
}

export interface BrowserCredentials {
  username: string;
  password: string;
}

/**
 * What the preload exposes as `window.browserAPI`. Reach it through
 * `browserBridge`, never directly.
 *
 * Every call names a session or tab; main refuses one outside the window's
 * workspace. Navigation goes only through `navigate`: a renderer never sets a
 * `<webview>`'s `src` after attach.
 */
export interface BrowserAPI {
  get(sessionId: string): Promise<BrowserSessionSnapshot>;
  /** Opens a tab (empty `url` for a blank one) and makes it active. Null when refused. */
  open(sessionId: string, url: string): Promise<BrowserTab | null>;
  close(tabId: string): Promise<void>;
  activate(tabId: string): Promise<void>;
  /** False when the address is not a web address or the tab is not the window's. */
  navigate(tabId: string, url: string): Promise<boolean>;
  /**
   * The window's own automatic retry of an unreachable page on this machine
   * (a dev server still starting). Moves the tab like `navigate`, but is
   * nobody's input: a timer is not the person. False for any other address.
   */
  retry(tabId: string, url: string): Promise<boolean>;
  back(tabId: string): Promise<void>;
  forward(tabId: string): Promise<void>;
  reload(tabId: string): Promise<void>;
  stop(tabId: string): Promise<void>;
  hardReload(tabId: string): Promise<void>;
  /** Starts or continues a search of the page. `forward` false steps back; `next` continues the same text. */
  find(tabId: string, text: string, options: { forward: boolean; next: boolean }): Promise<void>;
  stopFind(tabId: string): Promise<void>;
  /** Steps, resets or reads (`get`) the tab's zoom level, resolving the level now in force. */
  zoom(tabId: string, step: ZoomStep | 'get'): Promise<number>;
  openDevTools(tabId: string): Promise<void>;
  /** Pages the sender's workspace visited, newest first. */
  history(): Promise<BrowserHistoryEntry[]>;
  /** Servers listening on this machine that were started from the session's folder. Null when the scan could not answer. */
  localServers(sessionId: string): Promise<LocalServer[] | null>;
  /** Saves what the tab's page shows as a PNG and resolves its path; null when the tab has no live page. */
  capture(tabId: string): Promise<string | null>;
  /** Trusts the certificate a tab refused (loopback only) and reloads it. False when nothing was offered. */
  continueCertificate(tabId: string): Promise<boolean>;
  /** Answers a sign-in request with credentials, or null to cancel it. */
  answerAuth(id: string, credentials: BrowserCredentials | null): Promise<void>;
  /** Wipes the sender's workspace's cookies, storage, cache, history and certificate approvals. */
  clearData(): Promise<void>;
  /** Binds a mounted, attached `<webview>` (by its `getWebContentsId()`) to its tab. */
  attach(tabId: string, webContentsId: number): Promise<boolean>;
  /** Tells main which tab this window shows, or none (null both). Main decides which pages stay live. */
  setVisible(sessionId: string | null, tabId: string | null): Promise<void>;
  onSnapshot(callback: (message: BrowserSnapshotMessage) => void): () => void;
  onShortcut(callback: (message: BrowserShortcutMessage) => void): () => void;
  onFound(callback: (message: BrowserFoundMessage) => void): () => void;
  onAuthRequest(callback: (message: BrowserAuthRequestMessage) => void): () => void;
  onAuthCancelled(callback: (message: BrowserAuthCancelledMessage) => void): () => void;
}

// --- Addresses ---

/**
 * Loopback means this machine: `localhost`, any `*.localhost`, 127.0.0.0/8,
 * `::1` and `0.0.0.0` (what a dev server prints when it binds everywhere).
 */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  const octets = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!octets) return false;
  const parts = octets.slice(1).map(Number);
  return parts.every((n) => n <= 255) && parts[0] === 127;
}

/** A tab with nowhere to be yet: no address, or the placeholder one. It has no page. */
export function isBlankPageUrl(url: string): boolean {
  return url === '' || url === 'about:blank';
}

/** Pages are only ever web pages: `file:`, `data:`, `chrome:` and the rest never load. */
export function isAllowedPageUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export type AddressResolution =
  | { kind: 'url'; url: string }
  | { kind: 'search'; url: string }
  | { kind: 'rejected'; reason: string };

const SEARCH_URL = 'https://duckduckgo.com/?q=';

/** `scheme://`, or `scheme:` not followed by a port (so `localhost:3000` is no scheme). */
const EXPLICIT_SCHEME = /^([a-z][a-z0-9+.-]*):(?:\/\/|(?!\d+(?:[/?#]|$)))/i;

/**
 * Turns what a person typed into a page to open or a search to run. A web
 * address opens as typed; anything else with a scheme is refused rather than
 * searched, so a pasted `javascript:` or `file:` link does nothing.
 */
export function resolveAddressInput(input: string): AddressResolution {
  const text = input.trim();
  if (!text) return { kind: 'rejected', reason: 'Type an address or a search.' };

  const scheme = EXPLICIT_SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme !== 'http' && scheme !== 'https') {
      return {
        kind: 'rejected',
        reason: `Consola only opens web pages, not ${scheme}: addresses.`,
      };
    }
    return isAllowedPageUrl(text)
      ? { kind: 'url', url: new URL(text).href }
      : { kind: 'rejected', reason: 'That is not a valid web address.' };
  }

  const search = (): AddressResolution => ({
    kind: 'search',
    url: SEARCH_URL + encodeURIComponent(text),
  });
  if (/\s/.test(text)) return search();

  // Parse as a host to see what it is; the scheme is chosen from the answer.
  let host: URL;
  try {
    host = new URL(`http://${text}`);
  } catch {
    return search();
  }
  const loopback = isLoopbackHost(host.hostname);
  const isAddress =
    loopback || host.port !== '' || host.hostname.includes('.') || host.hostname.includes(':');
  if (!isAddress) return search();

  return { kind: 'url', url: loopback ? host.href : new URL(`https://${text}`).href };
}

// --- Terminal links ---

/** Where a link clicked in a terminal opens: Consola's browser, or the system's. */
export type TerminalLinkRule = 'local' | 'all' | 'never';

/**
 * Chooses where a terminal link opens. `local` keeps the person's own dev
 * servers in Consola and everything else outside; Shift flips the choice for
 * one click. A link that is not a web page never goes into a page.
 */
export function routeTerminalLink(
  uri: string,
  rule: TerminalLinkRule,
  shiftKey: boolean,
): 'consola' | 'system' {
  if (!isAllowedPageUrl(uri)) return 'system';
  const inConsola = rule === 'all' || (rule === 'local' && isLoopbackHost(new URL(uri).hostname));
  return inConsola !== shiftKey ? 'consola' : 'system';
}
