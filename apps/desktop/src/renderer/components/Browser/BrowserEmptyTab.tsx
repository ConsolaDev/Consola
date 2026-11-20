import { Clock, Globe, RefreshCw, Server } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserHistoryEntry, LocalServer } from '../../../shared/browser';
import { browserBridge } from '../../services/browserBridge';
import { recentPages } from './browserView';

interface BrowserEmptyTabProps {
  sessionId: string;
  /** Sends the tab (or opens the session's first one) to an address. */
  onOpen: (url: string) => Promise<boolean>;
}

/**
 * What a tab with nowhere to be shows instead of a page: the servers running
 * from this session's folder, which is usually what the agent just started,
 * and the pages this workspace visited lately. Choosing one navigates the tab.
 *
 * Mount it keyed by its session: the list it shows and a scan it has in
 * flight are that session's, and an answer arriving after it is gone is
 * dropped (`mounted`), never written for the session shown next.
 */
export function BrowserEmptyTab({ sessionId, onOpen }: BrowserEmptyTabProps) {
  const [servers, setServers] = useState<LocalServer[]>([]);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);

  // A scan runs when the view opens, when the window comes back into focus
  // (the likely moment a server was started elsewhere) and when asked for,
  // never on a timer and never while the document is hidden. A scan that
  // could not answer (null) leaves the list as it was.
  const mounted = useRef(true);
  const scanning = useRef(false);
  const [busy, setBusy] = useState(false);
  const scan = useCallback(async () => {
    if (scanning.current || document.hidden) return;
    scanning.current = true;
    setBusy(true);
    try {
      const found = await browserBridge.localServers(sessionId);
      if (found && mounted.current) setServers(found);
    } catch {
      // Keep what is shown.
    } finally {
      scanning.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [sessionId]);

  useEffect(() => {
    mounted.current = true;
    void scan();
    const onVisible = () => {
      if (!document.hidden) void scan();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted.current = false;
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [scan]);

  useEffect(() => {
    let cancelled = false;
    browserBridge.history().then(
      (entries) => {
        if (!cancelled) setHistory(entries);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const recent = recentPages(history);

  return (
    <div className="browser-empty" data-testid="browser-empty-tab">
      <Globe size={28} strokeWidth={1.5} />
      <p className="browser-empty-title">New tab</p>
      <p className="browser-empty-hint">Type an address or a search above.</p>

      <section className="browser-empty-section" aria-label="Local servers">
        <div className="browser-empty-heading-row">
          <h3 className="browser-empty-heading">Running here</h3>
          <button
            type="button"
            className="browser-empty-refresh"
            aria-label="Refresh local servers"
            title="Refresh"
            disabled={busy}
            onClick={() => void scan()}
          >
            <RefreshCw size={12} strokeWidth={1.75} />
          </button>
        </div>
        {servers.length === 0 && (
          <p className="browser-empty-hint">No servers running from this folder.</p>
        )}
        {servers.map((server) => (
          <button
            key={server.port}
            type="button"
            className="browser-empty-row"
            data-testid="browser-local-server"
            onClick={() => void onOpen(server.url)}
          >
            <Server size={14} strokeWidth={1.75} />
            <span className="browser-empty-row-main">localhost:{server.port}</span>
            <span className="browser-empty-row-note">{server.command}</span>
          </button>
        ))}
      </section>

      {recent.length > 0 && (
        <section className="browser-empty-section" aria-label="Recent pages">
          <h3 className="browser-empty-heading">Recent</h3>
          {recent.map((entry) => (
            <button
              key={entry.url}
              type="button"
              className="browser-empty-row"
              data-testid="browser-recent-page"
              onClick={() => void onOpen(entry.url)}
            >
              <Clock size={14} strokeWidth={1.75} />
              <span className="browser-empty-row-main">{entry.title.trim() || entry.url}</span>
              <span className="browser-empty-row-note">{entry.title.trim() ? entry.url : ''}</span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
