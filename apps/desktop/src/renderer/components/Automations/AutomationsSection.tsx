import { useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, Play } from 'lucide-react';
import type { AutomationsSnapshot, AutomationView, RunRecord } from '../../../shared/automations';
import type { CleanupResult, SessionVerdict, StalePreview } from '../../../shared/sessionCleanup';
import { automationsBridge } from '../../services/automationsBridge';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import './styles.css';

/**
 * Settings › Automations: what ~/.consola/factory.yml asks for, what is
 * waiting for approval, and what already ran.
 *
 * Read-only on the spec by design — the file is the source of truth, edited
 * in the person's own editor ("Open factory.yml"). Everything here is an
 * intent sent to main: run now, approve, dismiss.
 */
export function AutomationsSection() {
  const [snapshot, setSnapshot] = useState<AutomationsSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void automationsBridge.getSnapshot().then((initial) => {
      if (live && initial) setSnapshot(initial);
    });
    const unsubscribe = automationsBridge.onChanged(setSnapshot);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

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

  const waiting = snapshot?.runs.filter((run) => run.status === 'needs-approval') ?? [];
  const history = snapshot?.runs.filter((run) => run.status !== 'needs-approval').slice(0, 15) ?? [];

  return (
    <div className="settings-modal-section automations">
      <div className="automations-header">
        <h2 className="settings-modal-section-title">Automations</h2>
        <button
          type="button"
          className="dialog-button-secondary automations-small-button"
          onClick={() => void act('open', automationsBridge.openFile)}
          disabled={busy === 'open'}
        >
          <ExternalLink size={13} />
          Open factory.yml
        </button>
      </div>
      <p className="automations-description">
        Defined in <code>{snapshot?.filePath ?? '~/.consola/factory.yml'}</code> and run by Consola while it is
        open. A run missed while it was closed happens once, the next time it opens.
      </p>

      {error && <div className="automations-error" role="alert">{error}</div>}

      {snapshot && snapshot.issues.length > 0 && (
        <div className="automations-issues" role="status">
          <div className="automations-issues-title">
            <AlertTriangle size={13} />
            {snapshot.automations.length === 0 ? 'factory.yml did not load' : 'Some entries did not load'}
          </div>
          <ul>
            {snapshot.issues.map((issue, index) => (
              <li key={index}>
                {issue.line ? <span className="automations-line">line {issue.line}</span> : null}
                {issue.path ? <code>{issue.path}</code> : null} {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {waiting.length > 0 && (
        <section className="automations-group" aria-label="Waiting for approval">
          <h3 className="automations-group-title">Waiting for your approval</h3>
          {waiting.map((run) => (
            <div key={run.id} className="automations-card automations-card-waiting">
              <div className="automations-card-heading">
                <span className="automations-name">{runTitle(run)}</span>
                <span className="automations-meta">{formatTime(run.createdAt)} · {triggerLabel(run)}</span>
              </div>
              <p className="automations-summary">{run.summary}</p>
              <CleanupDetails result={run.result} />
              <div className="automations-card-actions">
                <button
                  type="button"
                  className="dialog-button-primary automations-small-button"
                  disabled={busy !== null}
                  onClick={() => void act(`approve:${run.id}`, () => automationsBridge.approve(run.id))}
                >
                  {busy === `approve:${run.id}` ? 'Running…' : 'Approve'}
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
              <p className="automations-hint">
                Approving acts only on what is listed, checking each again first. Ignored files in a removed
                worktree (build output, dependencies, local env files) go with it.
              </p>
            </div>
          ))}
        </section>
      )}

      <section className="automations-group" aria-label="Automations">
        {snapshot && snapshot.automations.length === 0 && snapshot.issues.length === 0 && (
          <div className="automations-empty">
            {snapshot.fileExists
              ? 'No automations in factory.yml yet.'
              : 'No factory.yml yet. Open it to start from a commented example — a daily cleanup of sessions whose pull request is merged or closed.'}
          </div>
        )}
        {snapshot?.automations.map((automation) => (
          <AutomationCard
            key={automation.name}
            automation={automation}
            running={busy === `run:${automation.name}` || isRunning(snapshot, automation.name)}
            disabled={busy !== null}
            onRun={() => void act(`run:${automation.name}`, () => automationsBridge.runNow(automation.name))}
          />
        ))}
      </section>

      {history.length > 0 && (
        <section className="automations-group" aria-label="Recent runs">
          <h3 className="automations-group-title">Recent runs</h3>
          <ul className="automations-history">
            {history.map((run) => (
              <li key={run.id} className="automations-history-row">
                <span className={`automations-dot automations-dot-${run.status}`} aria-label={run.status} />
                <span className="automations-name">{runTitle(run)}</span>
                <span className="automations-meta">{formatTime(run.createdAt)} · {triggerLabel(run)} · {run.mode}</span>
                <span className="automations-history-summary">{run.error ?? run.summary ?? run.status}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AutomationCard({
  automation,
  running,
  disabled,
  onRun,
}: {
  automation: AutomationView;
  running: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  return (
    <div className="automations-card">
      <div className="automations-card-main">
        <div className="automations-card-heading">
          <span className="automations-name">{automation.name}</span>
          <span className={`automations-mode automations-mode-${automation.mode}`}>{automation.mode}</span>
          {automation.asksFirst && <span className="automations-meta">asks once before running on its own</span>}
        </div>
        <div className="automations-meta">
          <code>{automation.target}</code> · <code>{automation.cron}</code>
          {automation.workspace ? ` · ${automation.workspace}` : ' · every workspace'}
        </div>
        {automation.problem ? (
          <div className="automations-problem">
            <AlertTriangle size={12} /> Not scheduled: {automation.problem}
            {automation.line ? ` (line ${automation.line})` : ''}
          </div>
        ) : (
          <div className="automations-meta">
            Next run {automation.nextRunAt ? formatTime(automation.nextRunAt) : 'never'}
          </div>
        )}
      </div>
      <button
        type="button"
        className="dialog-button-secondary automations-small-button"
        disabled={disabled || running || Boolean(automation.problem)}
        onClick={onRun}
        title={
          automation.mode === 'auto' && !automation.asksFirst
            ? 'Runs now'
            : 'Previews now; nothing changes until you approve'
        }
      >
        <Play size={12} />
        {running ? 'Running…' : 'Run now'}
      </button>
    </div>
  );
}

/**
 * The sessions a cleanup preview would remove, or a cleanup run removed, and
 * the ones kept with their reasons. Results of other tools render nothing.
 */
function CleanupDetails({ result }: { result: unknown }) {
  if (!isCleanupData(result)) return null;
  const going = 'candidates' in result ? result.candidates : [];
  const kept = result.skipped;
  return (
    <div className="automations-details">
      {going.length > 0 && (
        <ul>
          {going.map((verdict) => (
            <li key={verdict.sessionId}>
              <strong>{verdict.sessionName}</strong>
              {verdict.pullRequest ? ` — #${verdict.pullRequest.number} ${verdict.pullRequest.status}` : ''}
              {diskEffect(verdict)}
            </li>
          ))}
        </ul>
      )}
      {kept.length > 0 && (
        <details>
          <summary>{kept.length} kept</summary>
          <ul>
            {kept.map((verdict) => (
              <li key={verdict.sessionId}>
                <strong>{verdict.sessionName}</strong> — {verdict.detail ?? verdict.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function isCleanupData(result: unknown): result is StalePreview | CleanupResult {
  return typeof result === 'object' && result !== null && Array.isArray((result as { skipped?: unknown }).skipped);
}

function diskEffect(verdict: SessionVerdict): string {
  if (!verdict.worktree) return '';
  if (!verdict.worktree.remove) return ` · keeps its worktree (${verdict.worktree.keptBecause})`;
  const folder = verdict.worktree.path.split(/[\\/]/).pop();
  return ` · removes ${folder}${verdict.branch ? ` and ${verdict.branch}` : ''}`;
}

function isRunning(snapshot: AutomationsSnapshot, name: string): boolean {
  return snapshot.runs.some((run) => run.automationId === name && run.status === 'running');
}

/** An automation's name; for an agent's request, what it asks to do ("Delete session"). */
function runTitle(run: RunRecord): string {
  if (run.source !== 'manual') return run.automationId;
  const words = run.actionName.replace(/^consola#/, '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function triggerLabel(run: RunRecord): string {
  if (run.trigger.kind === 'cron') return run.trigger.catchUp ? 'catch-up' : 'scheduled';
  return run.trigger.by === 'agent' ? 'asked by an agent' : 'run now';
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
