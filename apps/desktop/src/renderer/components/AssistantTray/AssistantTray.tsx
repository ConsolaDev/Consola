import { useState } from 'react';
import { isAgentRunPreview, runTitle, type RunRecord } from '../../../shared/automations';
import { automationsBridge } from '../../services/automationsBridge';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { AgentRunDetails, CleanupDetails, formatTime } from '../Automations/RunDetails';
import './styles.css';

/**
 * What the Assistant asked for that waits for the person, beside its
 * conversation: the same details and the same approve and dismiss as
 * Settings › Automations, which keeps listing them too. Main tells the
 * Assistant what was decided, wherever it was.
 */
export function AssistantTray({ requests, onHide }: { requests: RunRecord[]; onHide: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (key: string, intent: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await intent();
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="assistant-tray" aria-label="Waiting for your approval">
      <div className="assistant-tray-header">
        <h2 className="assistant-tray-title">Waiting for you · {requests.length}</h2>
        <button type="button" className="assistant-tray-hide" onClick={onHide}>
          Hide
        </button>
      </div>
      {error && (
        <div className="automations-error assistant-tray-error" role="alert">
          {error}
        </div>
      )}
      <div className="assistant-tray-list">
        {requests.map((run) => {
          const agentRun = isAgentRunPreview(run.result) ? run.result : null;
          return (
            <article key={run.id} className="automations-card automations-card-waiting assistant-tray-card" aria-label={runTitle(run)}>
              <div className="automations-card-heading">
                <span className="automations-name">{runTitle(run)}</span>
                <span className="automations-meta">{formatTime(run.createdAt)}</span>
              </div>
              <p className="automations-summary">{run.summary}</p>
              {agentRun ? <AgentRunDetails preview={agentRun} /> : <CleanupDetails result={run.result} />}
              <div className="automations-card-actions">
                <button
                  type="button"
                  className="dialog-button-primary automations-small-button"
                  disabled={busy !== null}
                  onClick={() => void act(`approve:${run.id}`, () => automationsBridge.approve(run.id))}
                >
                  {busy === `approve:${run.id}` ? (agentRun ? 'Starting…' : 'Running…') : agentRun ? 'Start' : 'Approve'}
                </button>
                <button
                  type="button"
                  className="dialog-button-secondary automations-small-button"
                  disabled={busy !== null}
                  onClick={() => void act(`dismiss:${run.id}`, () => automationsBridge.dismiss(run.id))}
                >
                  Dismiss
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </aside>
  );
}
