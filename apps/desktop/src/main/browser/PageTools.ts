import type { BrowserWindow, WebContents } from 'electron';
import type { BrowserFoundMessage } from '../../shared/browser';
import { stepZoom, type FindResult, type ZoomStep } from '../../shared/browserTools';
import { IPC_CHANNELS } from '../../shared/constants';

/** A search longer than this is not a search a person typed. */
const MAX_FIND_LENGTH = 500;

/**
 * What a person does to a page rather than to the tab list: hard reload,
 * find, zoom and DevTools. Each acts on the tab's bound guest, found through
 * `guestOf`, and does nothing for a tab with no page.
 */
export class PageTools {
  constructor(private readonly guestOf: (tabId: string) => WebContents | undefined) {}

  public hardReload(tabId: string): void {
    this.guestOf(tabId)?.reloadIgnoringCache();
  }

  /**
   * Searches the page, highlighting without taking focus: the find bar keeps
   * the keyboard. `next` continues the same text; a new text starts over.
   * `found-in-page` reports back (see `findListeners`).
   */
  public findText(tabId: string, text: string, options: { forward: boolean; next: boolean }): void {
    const guest = this.guestOf(tabId);
    if (!guest || typeof text !== 'string' || text === '') return;
    const query = text.slice(0, MAX_FIND_LENGTH);
    // A new search passes no options at all: Electron 43 never reported back a
    // search started with explicit `{ forward: true, findNext: false }`.
    if (options?.next === true) {
      guest.findInPage(query, { forward: options.forward !== false, findNext: true });
    } else {
      guest.findInPage(query);
    }
  }

  public stopFind(tabId: string): void {
    this.guestOf(tabId)?.stopFindInPage('clearSelection');
  }

  /**
   * Steps, resets or reads (`get`) a page's zoom and answers the level
   * Chromium reports for it now. Chromium zooms per host within a partition
   * (as Chrome does), so tabs on one origin share a level and the level
   * follows the page across navigations; nothing here forces it per tab.
   * A tab with no page answers the default.
   */
  public zoom(tabId: string, step: ZoomStep | 'get'): number {
    const guest = this.guestOf(tabId);
    if (!guest) return 0;
    if (step === 'in' || step === 'out' || step === 'reset') {
      guest.setZoomLevel(stepZoom(guest.getZoomLevel(), step));
    }
    return guest.getZoomLevel();
  }

  /** Detached, so the page keeps its whole panel. */
  public openDevTools(tabId: string): void {
    this.guestOf(tabId)?.openDevTools({ mode: 'detach' });
  }
}

/**
 * Tells the window a tab's find result, or null when the search ended (a
 * navigation, or the page going away). Main is the one source: the find bar
 * never infers it from addresses.
 */
export function sendFound(host: BrowserWindow, tabId: string, result: FindResult | null): void {
  if (host.isDestroyed?.() || !host.webContents || host.webContents.isDestroyed?.()) return;
  const message: BrowserFoundMessage = { tabId, result };
  host.webContents.send(IPC_CHANNELS.BROWSER_FOUND, message);
}

/**
 * The guest-event side of find. `onFound` relays only the final result of a
 * search (Chromium reports as it counts). `endFind` is for a new document: its
 * count described the old one, and a "next" would continue a search the page
 * no longer has.
 */
export function findListeners(
  guest: WebContents,
  report: (result: FindResult | null) => void,
): {
  onFound: (
    event: unknown,
    result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean },
  ) => void;
  endFind: () => void;
} {
  return {
    onFound: (_event, result) => {
      if (!result.finalUpdate) return;
      report({ active: result.activeMatchOrdinal, total: result.matches });
    },
    endFind: () => {
      report(null);
      if (!guest.isDestroyed()) guest.stopFindInPage('clearSelection');
    },
  };
}
