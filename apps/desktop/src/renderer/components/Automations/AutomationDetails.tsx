import { useEffect, useId } from 'react';
import { AlertTriangle, Bot, ExternalLink } from 'lucide-react';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import { RunNowButton, RunRow, useIntent } from './parts';
import { filterRuns, formatTime, modeInWords, NO_RUN_FILTER } from './presentation';

/** Runs listed under an automation; the rest are in Activity. */
const RUNS_SHOWN = 30;

/**
 * One automation from factory.yml: its definition in words and as written,
 * who added it if an agent did, what can be done with it, and its own runs.
 * Opening it is the person seeing an agent-added entry, so it stops being new.
 */
export function AutomationDetails({ workspace, name }: { workspace: Workspace; name: string }) {
  const snapshot = useAutomationsStore((state) => state.snapshots[workspace.id]);
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const showAutomationRuns = useAutomationsStore((state) => state.showAutomationRuns);
  const { busy, error, act } = useIntent();
  const runsHeading = useId();
  const automation = snapshot?.automations.find((candidate) => candidate.name === name);
  const isNew = automation?.addedBy?.isNew ?? false;

  useEffect(() => {
    if (!isNew) return;
    automationsBridge.acknowledge(workspace.id, name).catch((failure: unknown) => {
      // Only the "New" marker rides on it; it stays until the next open.
      console.error('automations acknowledge failed:', failure);
    });
  }, [workspace.id, name, isNew]);

  if (!snapshot) return <p className="automations-hint">Loading…</p>;
  if (!automation) return <p className="automations-hint">factory.yml no longer has an automation named {name}.</p>;

  const now = new Date();
  // What Activity would list for it, so "All N in Activity" counts the same runs.
  const runs = filterRuns(snapshot.runs, { ...NO_RUN_FILTER, automation: name }, now);
  const running = runs.some((run) => run.status === 'running');

  return (
    <div className="automations-run-details">
      {error && <div className="automations-error" role="alert">{error}</div>}
      <dl className="automations-facts">
        <div className="automations-fact">
          <dt>Trigger</dt>
          <dd>
            {automation.trigger}
            {automation.schedule ? (
              <>
                {' '}
                (<code>{automation.schedule}</code>)
              </>
            ) : null}
          </dd>
        </div>
        <div className="automations-fact">
          <dt>Runs</dt>
          <dd>
            {automation.runs}
            {automation.kind === 'agent' ? ', read-only' : ''}
          </dd>
        </div>
        <div className="automations-fact">
          <dt>Mode</dt>
          <dd>
            <span className={`automations-mode automations-mode-${automation.mode}`}>{automation.mode}</span>{' '}
            {modeInWords(automation.mode, automation.asksFirst)}
          </dd>
        </div>
        <div className="automations-fact">
          <dt>Next run</dt>
          <dd>
            {automation.onEvent
              ? 'Checked on each Inbox refresh'
              : automation.nextRunAt
                ? formatTime(automation.nextRunAt)
                : 'never'}
          </dd>
        </div>
        {automation.line !== undefined && (
          <div className="automations-fact">
            <dt>Defined</dt>
            <dd>factory.yml line {automation.line}</dd>
          </div>
        )}
      </dl>
      {automation.addedBy && <p className="automations-meta">Added by {automation.addedBy.sessionName}</p>}
      {automation.problem && (
        <div className="automations-problem">
          <AlertTriangle size={12} /> Not running: {automation.problem}
        </div>
      )}

      <div className="automations-card-actions">
        <RunNowButton
          automation={automation}
          running={busy === 'run' || running}
          disabled={busy !== null}
          onRun={() => void act('run', () => automationsBridge.runNow(workspace.id, name))}
        />
        <button
          type="button"
          className="dialog-button-secondary automations-small-button"
          onClick={() => openPanel({ kind: 'new', basis: { automation: name } })}
        >
          <Bot size={12} />
          Change with agent
        </button>
        <button
          type="button"
          className="dialog-button-secondary automations-small-button"
          disabled={busy === 'open'}
          onClick={() => void act('open', () => automationsBridge.openFile(workspace.id))}
        >
          <ExternalLink size={12} />
          Open factory.yml
        </button>
      </div>

      <section className="automations-section automations-runs-section" aria-labelledby={runsHeading}>
        <div className="automations-runs-toolbar">
          <h3 id={runsHeading} className="automations-section-title automations-runs-heading">
            Runs
          </h3>
          {runs.length > 0 && (
            <button
              type="button"
              className="automations-link-button automations-runs-elsewhere"
              onClick={() => showAutomationRuns(workspace.id, name)}
            >
              {runs.length > RUNS_SHOWN ? `All ${runs.length} in Activity` : 'Open in Activity'}
            </button>
          )}
        </div>
        {runs.length > 0 ? (
          <ul className="automations-runs">
            {runs.slice(0, RUNS_SHOWN).map((run) => (
              <RunRow
                key={run.id}
                run={run}
                now={now}
                place={snapshot.queue[run.id]}
                onOpen={() => openPanel({ kind: 'run', runId: run.id })}
              />
            ))}
          </ul>
        ) : (
          <p className="automations-hint">No runs in the last 30 days.</p>
        )}
      </section>
    </div>
  );
}
