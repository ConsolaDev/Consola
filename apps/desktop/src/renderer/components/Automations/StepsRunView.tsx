import { useState, type ReactNode } from 'react';
import { RotateCcw, Square } from 'lucide-react';
import type { AutomationView, RunListEntry, RunRecord, StepRun } from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { RunAgainButton, useIntent } from './parts';
import { RunGraph } from './RunGraph';
import { StepDetail } from './StepDetailView';
import { StepsApprovalCard } from './StepsApprovalCard';
import { retryWarningOf, runRetryTarget, type RunStage } from './runPage';

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

  const retryTarget = runRetryTarget(run);
  const selected = steps.find((step) => step.id === picked) ?? defaultStep(steps);
  const selectedIndex = selected ? stages.findIndex((stage) => stage.step?.id === selected.id) : -1;
  // A command that may have done its work (Consola quit on it, or it was stopped, timed out or killed) asks first.
  const warning = retryTarget ? retryWarningOf(retryTarget, run.trigger.item) : null;

  const retry = (target: StepRun) =>
    act('retry', async () => {
      await automationsBridge.retry(run.id, target.id);
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
              onClick={() => (warning ? setConfirming(true) : void retry(retryTarget))}
            >
              <RotateCcw size={12} aria-hidden="true" />
              {busy === 'retry' ? 'Retrying…' : `Retry from ${retryTarget.id}`}
            </button>
          )}
          <RunAgainButton workspaceId={workspace.id} run={run} automation={automation} history={history} busy={busy} act={act} />
          {nav}
        </div>
        {retryTarget && warning && confirming && (
          <div className="automations-retry-warning" role="group" aria-label={`Retry from ${retryTarget.id}`}>
            <p className="automations-retry-warning-text">{warning}</p>
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

      {run.status === 'needs-approval' && (
        <section className="automations-detail-section" aria-label="Waiting for your approval">
          <h3 className="automations-section-title">Waiting for your approval</h3>
          <StepsApprovalCard runId={run.id} itemType={run.trigger.item?.type ?? null} />
        </section>
      )}

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

      {selected && <StepDetail key={`${run.id}:${selected.id}`} workspace={workspace} run={run} step={selected} />}
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
