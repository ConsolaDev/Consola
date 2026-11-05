import { useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, Play, RefreshCw } from 'lucide-react';
import {
  isAgentRunPreview,
  type AgentRunPreview,
  type AutomationsSnapshot,
  type AutomationView,
  type RunRecord,
} from '../../../shared/automations';
import type { CleanupResult, SessionVerdict, StalePreview } from '../../../shared/sessionCleanup';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import './styles.css';

/**
 * A workspace's Automations panel: what its own factory.yml asks for, what is
 * waiting for approval in it — its automations' plans and its agents'
 * requests to delete — what is queued to start, and what already ran.
 *
 * Read-only on the spec by design — the file is the source of truth, edited
 * in the person's own editor ("Open factory.yml"). Everything here is an
 * intent sent to main: run or check now, approve, dismiss.
 */
export function AutomationsPanel({
  workspace,
  onOpenSession,
}: {
  workspace: Workspace;
  /** Open one of this workspace's sessions, when this window can show it. */
  onOpenSession?: (sessionId: string) => void;
}) {
  const workspaceId = workspace.id;
  const [snapshot, setSnapshot] = useState<AutomationsSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    automationsBridge
      .getSnapshot(workspaceId)
      .then((initial) => {
        if (live && initial) setSnapshot(initial);
      })
      .catch((failure) => {
        if (live) setError(ipcErrorMessage(failure));
      });
    const unsubscribe = automationsBridge.onChanged((change) => {
      if (change.workspaceId === workspaceId) setSnapshot(change.snapshot);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [workspaceId]);

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
  const queued = (snapshot?.runs.filter((run) => run.status === 'queued') ?? []).sort(
    (a, b) => (snapshot?.queue[a.id] ?? 0) - (snapshot?.queue[b.id] ?? 0)
  );
  const history =
    snapshot?.runs.filter((run) => run.status !== 'needs-approval' && run.status !== 'queued').slice(0, 15) ?? [];
  const sessionOf = (run: RunRecord) =>
    run.sessionId ? workspace.sessions.find((session) => session.id === run.sessionId) : undefined;

  return (
    <section className="ws-panel automations">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Automations</h3>
        <button
          type="button"
          className="dialog-button-secondary automations-small-button"
          onClick={() => void act('open', () => automationsBridge.openFile(workspaceId))}
          disabled={busy === 'open'}
        >
          <ExternalLink size={13} />
          Open factory.yml
        </button>
      </div>
      <p className="ws-panel-hint">
        This workspace&rsquo;s own automations, each acting only on it. Defined in{' '}
        <code>{snapshot?.filePath ?? 'its factory.yml'}</code> and run by Consola while it is open. A run
        missed while it was closed happens once, the next time it opens. Sessions they start are read-only.
      </p>

      {error && <div className="automations-error" role="alert">{error}</div>}

      {snapshot?.suggestAssignedReviews && (
        <div className="automations-callout" role="region" aria-label="Review PRs assigned to me automatically">
          <div className="automations-callout-text">
            <div className="automations-callout-title">Review PRs assigned to me automatically</div>
            <p className="automations-hint">
              Adds <code>review-assigned-prs</code> to factory.yml: your {snapshot.suggestAssignedReviews.action} action
              runs, read-only, on each pull request that asks for your review or is assigned to you. It asks you once
              before the first.
            </p>
          </div>
          <button
            type="button"
            className="dialog-button-primary automations-small-button"
            onClick={() => void act('add-reviews', () => automationsBridge.addAssignedReviews(workspaceId))}
            disabled={busy === 'add-reviews'}
          >
            Add
          </button>
        </div>
      )}

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
          {waiting.map((run) => {
            const agentRun = isAgentRunPreview(run.result) ? run.result : null;
            return (
              <div key={run.id} className="automations-card automations-card-waiting">
                <div className="automations-card-heading">
                  <span className="automations-name">{runTitle(run)}</span>
                  <span className="automations-meta">{formatTime(run.createdAt)} · {triggerLabel(run)}</span>
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
                <p className="automations-hint">
                  {agentRun
                    ? 'Starting opens a read-only session with exactly this prompt: it can read the code and the change, and cannot run it or act on GitHub. It waits its turn if other automation sessions are working.'
                    : 'Approving acts only on what is listed, checking each again first. Ignored files in a removed worktree (build output, dependencies, local env files) go with it.'}
                </p>
              </div>
            );
          })}
        </section>
      )}

      {queued.length > 0 && (
        <section className="automations-group" aria-label="Waiting to start">
          <h3 className="automations-group-title">Waiting to start</h3>
          <p className="automations-hint">
            A few automation sessions work at once, across every workspace; the rest start in order as those finish
            or stop to wait for you.
          </p>
          <ul className="automations-history">
            {queued.map((run) => (
              <li key={run.id} className="automations-history-row automations-queue-row">
                <span className="automations-place">{snapshot?.queue[run.id] ?? '·'}</span>
                <span className="automations-name">{runTitle(run)}</span>
                <span className="automations-history-summary">
                  <RunItemLink run={run} fallback={run.summary} />
                </span>
                <button
                  type="button"
                  className="dialog-button-secondary automations-small-button automations-row-action"
                  disabled={busy !== null}
                  onClick={() => void act(`dismiss:${run.id}`, () => automationsBridge.dismiss(run.id))}
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="automations-group" aria-label="Automations">
        {snapshot && snapshot.automations.length === 0 && snapshot.issues.length === 0 && (
          <div className="automations-empty">
            {snapshot.fileExists
              ? 'No automations in this workspace’s factory.yml yet.'
              : 'No factory.yml for this workspace yet. Opening it starts one that reviews pull requests asking for your review or assigned to you (it asks once first), with a commented example of a daily cleanup of sessions whose pull request is merged or closed.'}
          </div>
        )}
        {snapshot?.automations.map((automation) => (
          <AutomationCard
            key={automation.name}
            automation={automation}
            running={busy === `run:${automation.name}` || isRunning(snapshot, automation.name)}
            disabled={busy !== null}
            onRun={() => void act(`run:${automation.name}`, () => automationsBridge.runNow(workspaceId, automation.name))}
          />
        ))}
      </section>

      {history.length > 0 && (
        <section className="automations-group" aria-label="Recent runs">
          <h3 className="automations-group-title">Recent runs</h3>
          <ul className="automations-history">
            {history.map((run) => {
              const session = sessionOf(run);
              return (
                <li key={run.id} className="automations-history-row">
                  <span className={`automations-dot automations-dot-${run.status}`} aria-label={run.status} />
                  <span className="automations-name">{runTitle(run)}</span>
                  {agentRunState(run) && <span className={`automations-state automations-state-${run.status}`}>{agentRunState(run)}</span>}
                  <span className="automations-meta">{formatTime(run.createdAt)} · {triggerLabel(run)} · {run.mode}</span>
                  <span className="automations-history-summary">
                    {run.trigger.item && (
                      <>
                        <RunItemLink run={run} />
                        {' · '}
                      </>
                    )}
                    {run.error ?? run.summary ?? run.status}
                    {session && onOpenSession && (
                      <>
                        {' '}
                        <button type="button" className="automations-link-button" onClick={() => onOpenSession(session.id)}>
                          Open session
                        </button>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </section>
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
  const checks = automation.onEvent;
  return (
    <div className="automations-card">
      <div className="automations-card-main">
        <div className="automations-card-heading">
          <span className="automations-name">{automation.name}</span>
          <span className={`automations-mode automations-mode-${automation.mode}`}>{automation.mode}</span>
          {automation.asksFirst && <span className="automations-meta">asks once before running on its own</span>}
        </div>
        <div className="automations-meta">
          {automation.trigger}
          {automation.schedule ? (
            <>
              {' '}
              (<code>{automation.schedule}</code>)
            </>
          ) : null}{' '}
          → {automation.runs}
          {automation.kind === 'agent' ? ', read-only' : ''}
        </div>
        {automation.problem ? (
          <div className="automations-problem">
            <AlertTriangle size={12} /> Not running: {automation.problem}
            {automation.line ? ` (line ${automation.line})` : ''}
          </div>
        ) : checks ? (
          <div className="automations-meta">Checked whenever the Inbox refreshes; only what is new fires.</div>
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
          checks
            ? 'Refresh the Inbox now; only what is new since the last check fires'
            : automation.mode === 'auto' && !automation.asksFirst
              ? 'Runs now'
              : 'Previews now; nothing changes until you approve'
        }
      >
        {checks ? <RefreshCw size={12} /> : <Play size={12} />}
        {running ? (checks ? 'Checking…' : 'Running…') : checks ? 'Check now' : 'Run now'}
      </button>
    </div>
  );
}

/** What an agent run will start: the item it is about, what it runs, and the exact prompt. */
function AgentRunDetails({ preview }: { preview: AgentRunPreview }) {
  return (
    <div className="automations-details">
      {preview.item && (
        <div>
          <a href={preview.item.url} target="_blank" rel="noreferrer">
            {preview.item.title}
          </a>{' '}
          by @{preview.item.author}
        </div>
      )}
      <div>
        {preview.runs}
        {preview.scope ? ` in ${preview.scope}` : ''}, read-only
      </div>
      <details>
        <summary>The prompt it will send</summary>
        <pre className="automations-prompt">{preview.prompt}</pre>
      </details>
    </div>
  );
}

/** The item an event run is about, linked; its title is the author's own text, shown as text. */
function RunItemLink({ run, fallback }: { run: RunRecord; fallback?: string }) {
  const item = run.trigger.item;
  if (!item) return <>{fallback ?? null}</>;
  return (
    <a href={item.url} target="_blank" rel="noreferrer">
      {item.title}
    </a>
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

/**
 * Where an agent run is, in words: its unattended turn is running, it
 * finished and the findings are in its session, or it stopped short.
 * Queued runs have their own section ("Waiting to start").
 */
function agentRunState(run: RunRecord): string | null {
  if ((run.result as { kind?: unknown } | undefined)?.kind !== 'agent-run') return null;
  if (run.status === 'running') return 'Running';
  if (run.status === 'completed') return 'Ready';
  if (run.status === 'failed') return 'Failed';
  return null;
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
  if (run.trigger.kind === 'event') return 'event';
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
