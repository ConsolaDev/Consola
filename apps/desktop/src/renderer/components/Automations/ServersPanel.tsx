import { useId, useState } from 'react';
import { Plug } from 'lucide-react';
import type { AutomationView, ServerUseView } from '../../../shared/automations';
import { automationsBridge } from '../../services/automationsBridge';
import { checkResultLines, serverLines } from './callWords';
import { CheckServerDialog } from './CheckServerDialog';

/**
 * The factory servers an automation's calls use, each with what it starts or
 * calls, Check server, and what its last check found. Check server is
 * offered in every mode: it is the person's own start, lists the server's
 * tools and calls none, and accepts nothing. Its result lives in the
 * engine's memory and arrives with the workspace's snapshot.
 */
export function ServersPanel({
  workspaceId,
  automation,
}: {
  workspaceId: string;
  automation: AutomationView;
}) {
  const heading = useId();
  const [asking, setAsking] = useState<ServerUseView | null>(null);
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set());
  const servers = automation.servers ?? [];
  if (servers.length === 0) return null;

  const check = async (server: ServerUseView) => {
    setChecking((current) => new Set([...current, server.name]));
    try {
      await automationsBridge.checkServer(
        workspaceId,
        automation.name,
        server.name,
        automation.version ?? '',
      );
    } finally {
      setChecking((current) => {
        const next = new Set(current);
        next.delete(server.name);
        return next;
      });
    }
  };

  return (
    <section className="automations-detail-section" aria-labelledby={heading}>
      <div className="automations-detail-section-head">
        <h3 id={heading} className="automations-section-title">
          Servers
        </h3>
      </div>
      <ul className="automations-servers">
        {servers.map((server) => (
          <li key={server.name} className="automations-server" aria-label={`Server ${server.name}`}>
            <div className="automations-server-head">
              <Plug size={13} aria-hidden="true" />
              <code>{server.name}</code>
              {server.description !== undefined && (
                <span className="automations-meta">{server.description}</span>
              )}
              <button
                type="button"
                className="dialog-button-secondary automations-small-button automations-server-check"
                disabled={checking.has(server.name)}
                onClick={() => setAsking(server)}
              >
                {checking.has(server.name) ? 'Checking…' : 'Check server'}
              </button>
            </div>
            {serverLines(server).map((line) => (
              <p key={line} className="automations-approval-description">
                {line}
              </p>
            ))}
            {server.lastCheck && (
              <div className="automations-server-check-result" role="status">
                {checkResultLines(server.lastCheck, {}).map((line) => (
                  <p key={line} className="automations-hint">
                    {line}
                  </p>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {asking && (
        <CheckServerDialog
          facts={asking}
          onStart={() => check(asking)}
          onClose={() => setAsking(null)}
        />
      )}
    </section>
  );
}
