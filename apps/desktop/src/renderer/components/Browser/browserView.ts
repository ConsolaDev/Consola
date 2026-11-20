import {
  isBlankPageUrl,
  isLoopbackHost,
  type BrowserHistoryEntry,
  type BrowserSessionSnapshot,
  type BrowserTabError,
  type BrowserTabSnapshot,
} from '../../../shared/browser';

/**
 * The decisions behind the in-app browser's pages, kept free of React and IO
 * so each one is tested on its own: which tabs have a page in this window, in
 * what order the host mounts them, which one shows, and what covers it.
 */

/** A tab the host keeps a page for, and the session it belongs to. */
export interface HostedTab {
  sessionId: string;
  tab: BrowserTabSnapshot;
}

/** A tab with nowhere to be yet. Main decides liveness by the same predicate. */
export const isBlankUrl = isBlankPageUrl;

/**
 * Which tabs have a page in this window: those of this workspace's sessions
 * that main calls `live`, except a blank tab, which shows its empty-tab view
 * and has no page until it has an address (an `about:blank` guest would only
 * flash white and hold a live-page slot). Main decides (it shows a tab, keeps one an agent
 * is using, and unloads the rest by `decideLive`); the window only mounts
 * what it is told and removes the element of a tab that stops being live.
 */
export function liveTabs(
  workspaceSessionIds: ReadonlySet<string>,
  snapshots: Readonly<Record<string, BrowserSessionSnapshot>>,
): HostedTab[] {
  const hosted: HostedTab[] = [];
  for (const [sessionId, snapshot] of Object.entries(snapshots)) {
    if (!workspaceSessionIds.has(sessionId)) continue;
    for (const tab of snapshot.tabs) {
      if (tab.live && !isBlankUrl(tab.url)) hosted.push({ sessionId, tab });
    }
  }
  return hosted;
}

/**
 * The key of a tab's element. A tab main unloads and shows again gets a new
 * load id, so it is a new element even when the window never rendered the
 * tab as not live in between (an element that stayed would keep a page main
 * has blanked, and never attach again).
 */
export function pageKey(tab: Pick<BrowserTabSnapshot, 'id' | 'loadId'>): string {
  return `${tab.id}:${tab.loadId}`;
}

/**
 * The order the host mounts pages in: the previous order with gone pages
 * dropped and new ones appended. Never anything else, because React moves an
 * element whose place among its siblings changes, and Electron destroys the
 * page of a `<webview>` that moves. Returns `previous` itself when nothing
 * changed, so it can sit in state without a render loop.
 */
export function hostOrder(previous: readonly string[], live: readonly string[]): string[] {
  const liveSet = new Set(live);
  const kept = previous.filter((id) => liveSet.has(id));
  const keptSet = new Set(kept);
  const added = live.filter((id) => !keptSet.has(id));
  if (added.length === 0 && kept.length === previous.length) return previous as string[];
  return [...kept, ...added];
}

/** The tab whose page fills the slot: the active tab of the session whose panel is on screen. */
export function visibleTabId(
  slotSessionId: string | null,
  snapshots: Readonly<Record<string, BrowserSessionSnapshot>>,
): string | null {
  if (!slotSessionId) return null;
  const snapshot = snapshots[slotSessionId];
  const active = snapshot?.tabs.find((tab) => tab.id === snapshot.activeTabId);
  return active?.id ?? null;
}

/**
 * How a mounted page is kept: `shown` over the slot, `painting` invisible but
 * still rendering (a page an agent is reading or capturing must keep
 * producing frames), or `hidden` with `display: none`.
 *
 * Never `visibility: hidden`: Electron 43 can leave a macOS guest permanently
 * blank after it.
 */
export type PagePresence = 'shown' | 'painting' | 'hidden';

export function pagePresence(
  tabId: string,
  visible: string | null,
  mustPaint: boolean,
): PagePresence {
  if (tabId === visible) return 'shown';
  return mustPaint ? 'painting' : 'hidden';
}

/**
 * Whether the person is kept out of a page altogether (`inert`): one kept
 * painting for an agent. It is invisible, yet laid out over the slot or, with
 * no slot on screen, the whole window, so without it the person could tab
 * into a page they cannot see, click it, or have it read aloud. A hidden page
 * is already out of reach (`display: none`), and a shown one is theirs.
 */
export function pageIsInert(presence: PagePresence): boolean {
  return presence === 'painting';
}

/**
 * The error drawn over a page. Main clears a tab's error the moment a new
 * load starts, so a retry would flash the page underneath (Chromium's own
 * error page) for as long as the attempt takes. The last error is held
 * instead until a load ends, with or without a new one.
 */
export function nextShownError(
  previous: BrowserTabError | null,
  tab: Pick<BrowserTabSnapshot, 'loading' | 'error'>,
): BrowserTabError | null {
  if (tab.error) return tab.error;
  return tab.loading ? previous : null;
}

/** Retries of a page on this machine wait this long first, doubling up to `RETRY_MAX_MS`. */
export const RETRY_FIRST_MS = 1_000;
export const RETRY_MAX_MS = 10_000;

/** How long to wait before retry number `attempt` (from 0). */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, attempt));
}

/**
 * The address to retry on its own, if any. Only a page on this machine that
 * could not be reached: that is a dev server still starting, which comes up
 * by itself. A remote site that is down, a crash or a refused certificate
 * waits for the person.
 */
export function autoRetryUrl(error: BrowserTabError | null): string | null {
  if (error?.kind !== 'unreachable') return null;
  try {
    return isLoopbackHost(new URL(error.url).hostname) ? error.url : null;
  } catch {
    return null;
  }
}

/**
 * What a tab is called in the strip: the page's title, else its host, else a
 * placeholder for a tab that has not been anywhere.
 */
export function tabLabel(tab: Pick<BrowserTabSnapshot, 'title' | 'url'>): string {
  const title = tab.title.trim();
  if (title) return title;
  try {
    const host = new URL(tab.url).host;
    if (host) return host;
  } catch {
    // Not an address: a blank tab.
  }
  return 'New tab';
}

/**
 * What the address bar shows while nobody is editing it. A page that failed
 * shows the address that failed, not the last one that loaded, since that is
 * the one the error is about; a blank tab shows nothing.
 */
export function addressText(
  tab: Pick<BrowserTabSnapshot, 'url'> | undefined,
  shownError: BrowserTabError | null,
): string {
  if (!tab) return '';
  const url = shownError && 'url' in shownError ? shownError.url : tab.url;
  return url === 'about:blank' ? '' : url;
}

/** How many recent pages the empty tab offers. */
const RECENT_PAGES_SHOWN = 5;

/** The history's newest pages, each address once. `history` is newest first already. */
export function recentPages(
  history: readonly BrowserHistoryEntry[],
  limit: number = RECENT_PAGES_SHOWN,
): BrowserHistoryEntry[] {
  const seen = new Set<string>();
  const pages: BrowserHistoryEntry[] = [];
  for (const entry of history) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    pages.push(entry);
    if (pages.length >= limit) break;
  }
  return pages;
}
