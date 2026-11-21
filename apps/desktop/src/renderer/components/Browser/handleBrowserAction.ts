import type { ForwardedShortcut } from '../../../shared/shortcuts';
import { browserBridge } from '../../services/browserBridge';
import { requestAddressFocus } from '../../stores/addressFocusStore';
import { requestFind } from '../../stores/browserFindStore';
import { activeTabOf, useBrowserStore } from '../../stores/browserStore';
import { useNavigationStore } from '../../stores/navigationStore';

/**
 * The tab a chord is about: the page it was pressed in, or, when main had not
 * bound that page yet, the active session's shown tab.
 */
function targetTab(tabId: string | null): string | null {
  if (tabId) return tabId;
  const sessionId = useNavigationStore.getState().activeSessionId;
  const snapshot = sessionId ? useBrowserStore.getState().snapshots[sessionId] : undefined;
  return (snapshot && activeTabOf(snapshot)?.id) ?? null;
}

/**
 * Runs one of the browser's own chords, pressed inside a page, on that page's
 * tab. The single switch every such chord goes through.
 *
 * The same chords pressed in the toolbar reach here through the panel's own
 * key handler, with no tab, and act on the session's shown page.
 */
export function handleBrowserAction(tabId: string | null, action: ForwardedShortcut): void {
  switch (action.kind) {
    case 'focus-address':
      requestAddressFocus();
      return;
    case 'find':
      requestFind();
      return;
    case 'reload':
    case 'hard-reload':
    case 'back':
    case 'forward':
    case 'zoom-in':
    case 'zoom-out':
    case 'zoom-reset': {
      const tab = targetTab(tabId);
      if (!tab) return;
      const done = (() => {
        switch (action.kind) {
          case 'reload':
            return browserBridge.reload(tab);
          case 'hard-reload':
            return browserBridge.hardReload(tab);
          case 'back':
            return browserBridge.back(tab);
          case 'forward':
            return browserBridge.forward(tab);
          case 'zoom-in':
            return browserBridge.zoom(tab, 'in');
          case 'zoom-out':
            return browserBridge.zoom(tab, 'out');
          default:
            return browserBridge.zoom(tab, 'reset');
        }
      })();
      done.catch((error: unknown) => console.warn('In-app browser action failed:', error));
      return;
    }
    default:
      return;
  }
}
