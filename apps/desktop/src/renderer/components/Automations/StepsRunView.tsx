import { useState, type ReactNode } from 'react';
import { RotateCcw, Square } from 'lucide-react';
import type { AutomationView, RunListEntry, RunRecord, StepRun } from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { RunAgainButton, useIntent } from './parts';
import { RunGraph } from './RunGraph';
import { isInterruptedCommand, type RunStage } from './runPage';

/** The retry warning for a command Consola quit on, word for word. */
const INTERRUPTED_WARNING = 'Consola quit while this command ran; check the pull request first — it may already be posted.';

/**
 * A `steps:` run's page: the run's lead and facts, one node per step, and the
 * selected step below. The failed step is selected until the person picks
 * another. Opening it reads the record only; Stop, Retry and Run again are
 * the only things here that start or end a process, and only when pressed.
 *
 * The lead, facts and run navigation are the run page's own, handed in so
 * both kinds of run read the same.
 */
export function StepsRunView({
  workspace,
  run,
  stages,
  history,
  automation,
  lead,
  stats,
  nav,
}: {
  workspace: Workspace;
  run: RunRecord;
  stages: RunStage[];
  history: RunListEntry[];
  automation: AutomationView | undefined;
  lead: ReactNode;
  stats: ReactNode;
  nav: ReactNode;
}) {
  const steps = run.steps ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const { busy, error, act } = useIntent();

  const failed = steps.find((step) => step.status === 'failed');
  // A run that failed before any step began (its checkout, say) retries from its first step.
  const retryTarget =
    run.status === 'failed' ? (failed ?? (steps.length > 0 && steps.every((step) => step.status === 'not-run') ? steps[0] : undefined)) : undefined;
  const selected = steps.find((step) => step.id === picked) ?? defaultStep(steps);
  const selectedIndex = selected ? stages.findIndex((stage) => stage.step?.id === selected.id) : -1;
  const interrupted = retryTarget ? isInterruptedCommand(retryTarget) : false;

  const retry = (target: StepRun) =>
    act('retry', async () => {
      // A run that never began has no failed step to name: a retry from its first step names none.
      await automationsBridge.retry(run.id, target === failed ? target.id : undefined);
      setConfirming(false);
    });

  return (
    <div className="automations-detail automations-run">
      <div className="automations-lead">
        {lead}
        <div className="automations-lead-actions">
          {run.status === 'running' && (
            <button
              type="button"
              className="dialog-button-secondary automations-small-button"
              disabled={stopping || busy !== null}
              onClick={() =>
                void act('stop', async () => {
                  await automationsBridge.stop(run.id);
                  setStopping(true);
                })
              }
            >
              <Square size={11} aria-hidden="true" />
              {stopping || busy === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          )}
          {retryTarget && !confirming && (
            <button
              type="button"
              className="dialog-button-secondary automations-small-button"
              disabled={busy !== null}
              onClick={() => (interrupted ? setConfirming(true) : void retry(retryTarget))}
            >
              <RotateCcw size={12} aria-hidden="true" />
              {busy === 'retry' ? 'Retrying…' : `Retry from ${retryTarget.id}`}
            </button>
          )}
          <RunAgainButton workspaceId={workspace.id} run={run} automation={automation} history={history} busy={busy} act={act} />
          {nav}
        </div>
        {retryTarget && confirming && (
          <div className="automations-retry-warning" role="group" aria-label={`Retry from ${retryTarget.id}`}>
            <p className="automations-retry-warning-text">{INTERRUPTED_WARNING}</p>
            <div className="automations-card-actions">
              <button
                type="button"
                className="dialog-button-primary automations-small-button"
                disabled={busy !== null}
                onClick={() => void retry(retryTarget)}
              >
                {busy === 'retry' ? 'Retrying…' : 'Retry'}
              </button>
              <button
                type="button"
                className="dialog-button-secondary automations-small-button"
                disabled={busy !== null}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="automations-error automations-lead-error" role="alert">
            {error}
          </p>
        )}
      </div>

      {stats}

      <section className="automations-detail-section" aria-label="Stages">
        <RunGraph
          run={run}
          stages={stages}
          targets={{}}
          onReveal={() => undefined}
          selectedStep={selectedIndex}
          onSelectStep={(index) => setPicked(stages[index]?.step?.id ?? null)}
        />
      </section>

      {selected && <StepPlaceholder step={selected} />}
    </div>
  );
}

/**
 * The step the page opens on: the one the run failed at; else the one
 * working or waiting now; else the last one that ran.
 */
function defaultStep(steps: StepRun[]): StepRun | undefined {
  const failed = steps.find((step) => step.status === 'failed');
  if (failed) return failed;
  const live = steps.find((step) => step.status === 'running' || step.status === 'queued');
  if (live) return live;
  const ran = steps.filter((step) => step.status === 'completed' || step.status === 'reported');
  return ran[ran.length - 1] ?? steps[0];
}

/** Until the step's own detail lands: what it is, how it went, and why if it did not. */
function StepPlaceholder({ step }: { step: StepRun }) {
  return (
    <section className="automations-detail-section automations-run-section" aria-label={`Step ${step.id}`}>
      <div className="automations-detail-section-head">
        <h3 className="automations-section-title">{step.id}</h3>
      </div>
      <p className="automations-hint">
        {step.kind === 'agent' ? 'Agent step' : 'Command'} · {step.status}
      </p>
      {step.skipped && <p className="automations-hint">{step.skipped}</p>}
      {step.error && <p className="automations-hint">{step.error}</p>}
    </section>
  );
}
