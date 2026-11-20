import { useEffect, useLayoutEffect, type KeyboardEvent } from 'react';
import { browserBridge } from '../../services/browserBridge';
import { matchBrowserFocusedShortcut } from '../../../shared/shortcuts';
import { closeFind, useBrowserFindStore } from '../../stores/browserFindStore';
import { chordOf, PLATFORM } from '../../utils/platform';
import { clearAgentDot } from '../../stores/browserAgentDotStore';
import { showBrowserSlot } from '../../stores/browserSlotStore';
import { activeTabOf, loadBrowser, useBrowserSnapshot } from '../../stores/browserStore';
import { isBlankUrl } from './browserView';
import { BrowserEmptyTab } from './BrowserEmptyTab';
import { handleBrowserAction } from './handleBrowserAction';
import { FindBar } from './FindBar';
import { BrowserTabStrip } from './BrowserTabStrip';
import { BrowserToolbar } from './BrowserToolbar';
import './styles.css';

interface BrowserPanelProps {
  sessionId: string;
  /** The session's terminal, where a screenshot's path is pasted. */
  instanceId: string;
  /** The session's checkout, which decides how a pasted path is written. */
  cwd: string;
}

/**
 * The browser beside a session: its toolbar, and the slot its page is drawn
 * over. The page is not in here. It lives in `BrowserHost` at the layout's
 * root, because this panel unmounts with every overlay and a `<webview>` that
 * moves loses its page; the slot only says where to draw it.
 */
export function BrowserPanel({ sessionId, instanceId, cwd }: BrowserPanelProps) {
  const snapshot = useBrowserSnapshot(sessionId);
  const tab = activeTabOf(snapshot);

  useEffect(() => {
    void loadBrowser(sessionId);
  }, [sessionId]);

  const findOpen = useBrowserFindStore((state) => state.open);

  // A search belongs to one page: another tab, or the panel going away, ends it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab's id is the trigger, not a value read
  useEffect(() => {
    closeFind();
    return closeFind;
  }, [tab?.id]);

  // Before paint, so the page lands in the slot on the panel's first frame.
  // Showing the session is the person seeing what its agent did there.
  useLayoutEffect(() => {
    const hide = showBrowserSlot(sessionId);
    clearAgentDot(sessionId);
    return hide;
  }, [sessionId]);

  // An address goes to the page showing, or opens the session's first one.
  const open = async (url: string): Promise<boolean> =>
    tab ? browserBridge.navigate(tab.id, url) : (await browserBridge.open(sessionId, url)) !== null;

  // The browser's chords pressed in the panel itself (toolbar, address bar,
  // find bar): a page's keys never get here, main forwards those. The terminal
  // is not inside this panel, so it keeps its keys.
  const onKeyDown = (event: KeyboardEvent) => {
    const kind = matchBrowserFocusedShortcut(chordOf(event.nativeEvent), PLATFORM);
    if (!kind) return;
    event.preventDefault();
    // Holding a key repeats it; only zoom is worth repeating.
    if (event.repeat && !kind.startsWith('zoom')) return;
    handleBrowserAction(null, { kind });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only listens for keys bubbling from the controls inside
    <div className="browser-panel" data-testid="browser-panel" onKeyDown={onKeyDown}>
      <BrowserTabStrip sessionId={sessionId} snapshot={snapshot} />
      <BrowserToolbar
        key={`${sessionId}:${tab?.id ?? ''}`}
        tab={tab}
        onOpen={open}
        instanceId={instanceId}
        cwd={cwd}
      />
      {findOpen && tab && <FindBar key={tab.id} tabId={tab.id} onClose={closeFind} />}
      <div className="browser-slot" data-testid="browser-slot">
        {(!tab || isBlankUrl(tab.url)) && <BrowserEmptyTab sessionId={sessionId} onOpen={open} />}
      </div>
    </div>
  );
}
