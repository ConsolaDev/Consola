import { routeTerminalLink } from '../../../shared/browser';
import { browserBridge } from '../../services/browserBridge';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';

/**
 * Open a link clicked in a session's terminal, in its Browser tab or in the
 * OS browser, by the person's rule (`Preferences.terminalLinks`)
 * and whether Shift was held. The rule is read at the click, so a change in
 * Settings applies to links already on screen.
 *
 * The system route is a `window.open(uri)`. xterm's own activation — the
 * web-links addon's and the OSC 8 one in core — calls `window.open()` with no
 * URL and assigns `location.href` on the window it gets back. That never works
 * here: main's window-open handler denies every popup and forwards only the URL
 * it was handed, and a blank one is no URL at all. So `window.open()` returns
 * null, the addon logs "Opening link blocked" and nothing happens. Passing the
 * URL is what lets the handler send it on to `shell.openExternal`, the same
 * path the app's `target="_blank"` anchors take.
 *
 * Shared by both link kinds: the addon calls with `(event, uri)`, xterm's
 * `ILinkHandler.activate` adds a buffer range this ignores. Both reach it
 * through `terminalLinkHandler`, which says which session the terminal is.
 */
export function openTerminalLink(sessionId: string, event: MouseEvent, uri: string): void {
  const { terminalLinks } = usePreferencesStore.getState();
  if (routeTerminalLink(uri, terminalLinks, event.shiftKey) === 'system') {
    window.open(uri, '_blank');
    return;
  }
  // The Browser tab opens at once: the page tab is main's to create, and a
  // refused address simply leaves the browser as it was, empty or not.
  useSidePanelStore.getState().openKind('browser');
  browserBridge.open(sessionId, uri).catch((error: unknown) => {
    console.error('Could not open a terminal link in the browser.', error);
  });
}

/** The `(event, uri)` callback xterm's link handler and the web-links addon take, for one session. */
export function terminalLinkHandler(sessionId: string): (event: MouseEvent, uri: string) => void {
  return (event, uri) => openTerminalLink(sessionId, event, uri);
}
