import { useEffect, useLayoutEffect } from 'react';
import { Globe } from 'lucide-react';
import { browserBridge } from '../../services/browserBridge';
import { showBrowserSlot } from '../../stores/browserSlotStore';
import { activeTabOf, loadBrowser, useBrowserSnapshot } from '../../stores/browserStore';
import { BrowserToolbar } from './BrowserToolbar';
import './styles.css';

interface BrowserPanelProps {
  sessionId: string;
}

/**
 * The browser beside a session: its toolbar, and the slot its page is drawn
 * over. The page is not in here. It lives in `BrowserHost` at the layout's
 * root, because this panel unmounts with every overlay and a `<webview>` that
 * moves loses its page; the slot only says where to draw it.
 */
export function BrowserPanel({ sessionId }: BrowserPanelProps) {
  const snapshot = useBrowserSnapshot(sessionId);
  const tab = activeTabOf(snapshot);

  useEffect(() => {
    void loadBrowser(sessionId);
  }, [sessionId]);

  // Before paint, so the page lands in the slot on the panel's first frame.
  useLayoutEffect(() => showBrowserSlot(sessionId), [sessionId]);

  // An address goes to the page showing, or opens the session's first one.
  const open = async (url: string): Promise<boolean> =>
    tab ? browserBridge.navigate(tab.id, url) : (await browserBridge.open(sessionId, url)) !== null;

  return (
    <div className="browser-panel" data-testid="browser-panel">
      <BrowserToolbar key={`${sessionId}:${tab?.id ?? ''}`} tab={tab} onOpen={open} />
      <div className="browser-slot" data-testid="browser-slot">
        {!tab && (
          <div className="browser-empty">
            <Globe size={28} strokeWidth={1.5} />
            <p className="browser-empty-title">No page open</p>
            <p className="browser-empty-hint">Type an address or a search above.</p>
          </div>
        )}
      </div>
    </div>
  );
}
