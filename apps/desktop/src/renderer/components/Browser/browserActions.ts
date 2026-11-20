import { browserBridge } from '../../services/browserBridge';
import { requestAddressFocus } from '../../stores/addressFocusStore';
import { activeTabOf, loadBrowser, useBrowserStore } from '../../stores/browserStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { isBlankUrl } from './browserView';

/** The palette closes and hands focus back; the address bar asks for it once that has settled. */
const FOCUS_AFTER_PALETTE_MS = 150;

/**
 * Opens an address in a session's browser, for the palette's rows: shows the
 * panel, and loads the address in a blank tab if that is what is showing, else
 * in a new tab so the page the person was on stays. A session at its tab cap
 * reuses the one showing.
 */
export async function openInSessionBrowser(sessionId: string, url: string): Promise<void> {
  useNavigationStore.getState().setBrowserVisible(true);
  try {
    await loadBrowser(sessionId);
    const tab = activeTabOf(
      useBrowserStore.getState().snapshots[sessionId] ?? { tabs: [], activeTabId: null },
    );
    if (tab && isBlankUrl(tab.url)) {
      await browserBridge.navigate(tab.id, url);
    } else if ((await browserBridge.open(sessionId, url)) === null && tab) {
      await browserBridge.navigate(tab.id, url);
    }
  } catch (error) {
    console.warn('In-app browser action failed:', error);
  }
}

/**
 * Puts the caret in the address bar of the session's browser, showing the
 * panel and a blank tab first when there is none, so the person can type
 * where the address will go. The one other place focus enters the panel, and
 * like the chord it only ever follows the person's own action.
 */
export async function focusSessionAddressBar(sessionId: string): Promise<void> {
  useNavigationStore.getState().setBrowserVisible(true);
  let tabId: string | null = null;
  try {
    await loadBrowser(sessionId);
    const snapshot = useBrowserStore.getState().snapshots[sessionId];
    const shown = snapshot && activeTabOf(snapshot);
    tabId = shown ? shown.id : ((await browserBridge.open(sessionId, ''))?.id ?? null);
  } catch (error) {
    console.warn('In-app browser action failed:', error);
  }
  // For that tab's bar, which waits for it if it is not on screen yet.
  setTimeout(() => requestAddressFocus(tabId), FOCUS_AFTER_PALETTE_MS);
}
