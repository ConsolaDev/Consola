/**
 * The in-app browser's shared vocabulary: what is persisted, what is live,
 * and the pure rules for addresses and links. No IO and no Node or DOM
 * imports, because main, the renderer and tests all read it.
 */

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
  | { kind: 'certificate'; url: string; host: string; error: string }
  /** The guest's renderer process died. */
  | { kind: 'crashed' };

export interface BrowserTabLive {
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Absent while the page is fine. */
  error?: BrowserTabError | null;
  favicon?: string;
  /** Whether a guest exists for this tab; hidden tabs unload to save memory. */
  live: boolean;
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

/** What a window receives on `BROWSER_SNAPSHOT`: one session's tabs, merged with live state. */
export interface BrowserSnapshotMessage {
  sessionId: string;
  snapshot: BrowserSessionSnapshot;
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
  back(tabId: string): Promise<void>;
  forward(tabId: string): Promise<void>;
  reload(tabId: string): Promise<void>;
  stop(tabId: string): Promise<void>;
  /** Binds a mounted, attached `<webview>` (by its `getWebContentsId()`) to its tab. */
  attach(tabId: string, webContentsId: number): Promise<boolean>;
  onSnapshot(callback: (message: BrowserSnapshotMessage) => void): () => void;
  onShortcut(callback: () => void): () => void;
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
