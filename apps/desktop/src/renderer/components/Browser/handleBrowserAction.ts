import type { ForwardedShortcut } from '../../../shared/shortcuts';
import { browserBridge } from '../../services/browserBridge';
import { requestAddressFocus } from '../../stores/addressFocusStore';
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
 * Chords main forwards that nothing here handles yet (find, zoom, hard
 * reload) are ignored: the page gave the key up, and doing nothing is the
 * honest answer until they exist.
 */
export function handleBrowserAction(tabId: string | null, action: ForwardedShortcut): void {
  switch (action.kind) {
    case 'focus-address':
      requestAddressFocus();
      return;
    case 'reload':
    case 'back':
    case 'forward': {
      const tab = targetTab(tabId);
      if (!tab) return;
      const done =
        action.kind === 'reload'
          ? browserBridge.reload(tab)
          : action.kind === 'back'
            ? browserBridge.back(tab)
            : browserBridge.forward(tab);
      done.catch((error: unknown) => console.warn('In-app browser action failed:', error));
      return;
    }
    default:
      return;
  }
}
