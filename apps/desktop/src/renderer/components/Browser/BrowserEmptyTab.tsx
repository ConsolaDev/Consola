import { Clock, Globe, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BrowserHistoryEntry, LocalServer } from '../../../shared/browser';
import { browserBridge } from '../../services/browserBridge';
import { recentPages } from './browserView';

interface BrowserEmptyTabProps {
  sessionId: string;
  /** Sends the tab (or opens the session's first one) to an address. */
  onOpen: (url: string) => Promise<boolean>;
}

/** A server started after the tab opened turns up without the person reopening it. */
const REFRESH_MS = 5_000;

/**
 * What a tab with nowhere to be shows instead of a page: the servers running
 * from this session's folder, which is usually what the agent just started,
 * and the pages this workspace visited lately. Choosing one navigates the tab.
 */
export function BrowserEmptyTab({ sessionId, onOpen }: BrowserEmptyTabProps) {
  const [servers, setServers] = useState<LocalServer[]>([]);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      browserBridge.localServers(sessionId).then(
        (found) => {
          if (!cancelled) setServers(found);
        },
        () => {},
      );
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);

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

      {servers.length > 0 && (
        <section className="browser-empty-section" aria-label="Local servers">
          <h3 className="browser-empty-heading">Running here</h3>
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
      )}

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
