import { useId, useState, type ReactNode } from 'react';
import {
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  Clock,
  LoaderCircle,
  RotateCcw,
  ScanSearch,
  Square,
  type LucideIcon,
} from 'lucide-react';
import type { AutomationView, RunListEntry, RunRecord, StepRun } from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { RunAgainButton, useIntent } from './parts';
import { StepDetail } from './StepDetailView';
import { StepsApprovalCard } from './StepsApprovalCard';
import { retryWarningOf, runRetryTarget } from './runPage';
import {
  durationOf,
  failureWords,
  retryScope,
  runIsOver,
  stepCounts,
  stepOutcome,
  stepSummary,
  stepTone,
  type StepTone,
} from './stepDetail';
import { formatElapsed } from './presentation';

const TONE_ICONS: Record<StepTone, LucideIcon> = {
  passed: CircleCheck,
  failed: CircleX,
  running: LoaderCircle,
  waiting: Clock,
  pending: CircleDot,
  skipped: CircleDashed,
  'not-run': CircleSlash,
  reported: ScanSearch,
};

/**
 * A `steps:` run's page: the run's lead and facts, what went wrong when it
 * failed, then its trace — every step in file order, as a CI service lists
 * a job's steps, each saying in a line what it did and opening onto all of
 * it in place.
 *
 * A step that failed, runs or waits opens by itself, and stays open once it
 * has: what the person was reading does not fold away when it finishes.
 * Opening the page reads the record only; Stop, Retry and Run again are the
 * only things here that start or end a process, and only when pressed.
 *
 * The lead, facts and run navigation are the run page's own, handed in so
 * both kinds of run read the same.
 */
export function StepsRunView({
  workspace,
  run,
  now,
  history,
  automation,
  lead,
  stats,
  nav,
}: {
  workspace: Workspace;
  run: RunRecord;
  /** The page's clock: by the second while the run moves. */
  now: Date;
  history: RunListEntry[];
  automation: AutomationView | undefined;
  lead: ReactNode;
  stats: ReactNode;
  nav: ReactNode;
}) {
  const steps = run.steps ?? [];
  const ids = useId();
  const rowId = (stepId: string) => `${ids}-step-${stepId}`;
  const over = runIsOver(run.status);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const { busy, error, act } = useIntent();

  // The person's own choice per step wins; else a step is open once it has failed, run or waited.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const arriving = steps
    .filter((step) => opensItself(step) && !opened.has(step.id))
    .map((step) => step.id);
  const openedNow = arriving.length > 0 ? new Set([...opened, ...arriving]) : opened;
  if (openedNow !== opened) setOpened(openedNow);
  const isOpen = (stepId: string) => chosen[stepId] ?? openedNow.has(stepId);
  const allOpen = steps.length > 0 && steps.every((step) => isOpen(step.id));

  const retryTarget = runRetryTarget(run);
  // A command that may have done its work (Consola quit on it, or it was stopped, timed out or killed) asks first.
  const warning = retryTarget ? retryWarningOf(retryTarget, run.trigger.item) : null;
  const canRunAgain = automation !== undefined && !automation.onEvent;

  const retry = (target: StepRun) =>
    act('retry', async () => {
      await automationsBridge.retry(run.id, target.id);
      setConfirming(false);
    });

  const showStep = (stepId: string) => {
    setChosen((current) => ({ ...current, [stepId]: true }));
    requestAnimationFrame(() => revealRow(rowId(stepId)));
  };

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
              title={`Run ${retryTarget.id} again, and the steps after it, in this run`}
              onClick={() => (warning ? setConfirming(true) : void retry(retryTarget))}
            >
              <RotateCcw size={12} aria-hidden="true" />
              {busy === 'retry' ? 'Retrying…' : `Retry from ${retryTarget.id}`}
            </button>
          )}
          <RunAgainButton
            workspaceId={workspace.id}
            run={run}
            automation={automation}
            history={history}
            busy={busy}
            act={act}
          />
          {nav}
        </div>
        {retryTarget && warning && confirming && (
          <div
            className="automations-retry-warning"
            role="group"
            aria-label={`Retry from ${retryTarget.id}`}
          >
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

      {run.status === 'failed' && (
        <FailureNote
          run={run}
          steps={steps}
          retryTarget={retryTarget}
          canRunAgain={canRunAgain}
          onShow={showStep}
        />
      )}

      {stats}

      {run.status === 'needs-approval' ? (
        <section className="automations-detail-section" aria-label="Waiting for your approval">
          <h3 className="automations-section-title">Waiting for your approval</h3>
          <StepsApprovalCard runId={run.id} itemType={run.trigger.item?.type ?? null} />
        </section>
      ) : (
        steps.length > 0 && (
          <section
            className="automations-detail-section automations-trace-section"
            aria-labelledby={`${ids}-trace`}
          >
            <div className="automations-detail-section-head">
              <h3 id={`${ids}-trace`} className="automations-section-title">
                Steps <span className="automations-trace-counts">{stepCounts(steps, over)}</span>
              </h3>
              <button
                type="button"
                className="automations-trace-all"
                onClick={() =>
                  setChosen(Object.fromEntries(steps.map((step) => [step.id, !allOpen])))
                }
              >
                {allOpen ? 'Collapse all' : 'Expand all'}
              </button>
            </div>
            <ol className="automations-trace" aria-label="Steps of this run">
              {steps.map((step) => (
                <StepRow
                  key={step.id}
                  id={rowId(step.id)}
                  workspace={workspace}
                  run={run}
                  step={step}
                  now={now}
                  open={isOpen(step.id)}
                  onToggle={() =>
                    setChosen((current) => ({ ...current, [step.id]: !isOpen(step.id) }))
                  }
                />
              ))}
            </ol>
          </section>
        )
      )}
    </div>
  );
}

/** A step opens itself when it is where the run broke or stands now. */
function opensItself(step: StepRun): boolean {
  return step.status === 'failed' || step.status === 'running' || step.status === 'queued';
}

/**
 * One step of the trace: how it went and what it did in a line, opening
 * onto its whole trace in place. The row is the step's region, so what it
 * did is never far from which step it was.
 */
function StepRow({
  id,
  workspace,
  run,
  step,
  now,
  open,
  onToggle,
}: {
  id: string;
  workspace: Workspace;
  run: RunRecord;
  step: StepRun;
  now: Date;
  open: boolean;
  onToggle: () => void;
}) {
  const tone = stepTone(step.status, runIsOver(run.status));
  const ms = durationOf(step, now);
  const outcome = stepOutcome(tone, ms);
  const summary = stepSummary(step, run);
  const Icon = TONE_ICONS[tone];
  const bodyId = `${id}-body`;
  const ran = tone === 'passed' || tone === 'failed' || tone === 'running';

  return (
    <li
      id={id}
      tabIndex={-1}
      className={`automations-trace-step automations-trace-${tone} ${open ? 'automations-trace-open' : ''}`}
    >
      <section aria-label={`Step ${step.id}`}>
        <button
          type="button"
          className="automations-trace-head"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${step.id}: ${outcome}`}
          onClick={onToggle}
        >
          <Icon
            size={15}
            className={`automations-trace-icon ${tone === 'running' ? 'automations-spin' : ''}`}
            aria-hidden="true"
          />
          <span className="automations-trace-main">
            <span className="automations-trace-name">
              <span className="automations-trace-id">{step.id}</span>
              <span className="automations-trace-kind">
                {step.kind === 'agent' ? 'Agent' : 'Command'}
              </span>
            </span>
            {summary && !open && <span className="automations-trace-summary">{summary}</span>}
          </span>
          <span className="automations-trace-outcome">
            {ran ? (ms !== null ? formatElapsed(ms) : '') : outcome}
          </span>
          <ChevronRight size={14} className="automations-trace-chevron" aria-hidden="true" />
        </button>
        {open && (
          <div id={bodyId} className="automations-trace-body">
            <StepDetail key={`${run.id}:${step.id}`} workspace={workspace} run={run} step={step} />
          </div>
        )}
      </section>
    </li>
  );
}

/**
 * What went wrong, said once at the top in plain words: the step the run
 * failed at and why, what it never got to because of it, and what Retry
 * does against Run again.
 */
function FailureNote({
  run,
  steps,
  retryTarget,
  canRunAgain,
  onShow,
}: {
  run: RunRecord;
  steps: StepRun[];
  retryTarget: StepRun | undefined;
  canRunAgain: boolean;
  onShow: (stepId: string) => void;
}) {
  const failed = steps.find((step) => step.status === 'failed');
  const words = failureWords(failed ? failed.error : run.error);
  const notRun = steps.filter((step) => step.status === 'not-run').map((step) => step.id);
  const scope = retryTarget ? retryScope(steps, retryTarget.id) : null;
  const first = steps[0]?.id;

  return (
    <div className="automations-annotation automations-failure" role="note">
      <CircleX size={16} aria-hidden="true" />
      <div className="automations-annotation-body">
        <strong>
          {failed ? (
            <>
              Failed at{' '}
              <button
                type="button"
                className="automations-failure-step"
                onClick={() => onShow(failed.id)}
                title={`Show ${failed.id}’s trace`}
              >
                {failed.id}
              </button>
            </>
          ) : (
            'Failed before its steps finished'
          )}
        </strong>
        <p className="automations-failure-text">{words.text}</p>
        {words.quote && <p className="automations-annotation-message">{words.quote}</p>}
        {notRun.length > 0 && (
          <p className="automations-failure-text">
            Because of this, <Ids ids={notRun} /> did not run.
          </p>
        )}
        {((retryTarget && scope) || (canRunAgain && first)) && (
          <ul className="automations-failure-options">
            {retryTarget && scope && (
              <li>
                <b>Retry from {retryTarget.id}</b> runs <Ids ids={[retryTarget.id]} /> again
                {scope.later.length > 0 && (
                  <>
                    , then <Ids ids={scope.later} />
                  </>
                )}
                , as this run defined {scope.later.length > 0 ? 'them' : 'it'}
                {scope.earlier.length > 0 && (
                  <>
                    ; <Ids ids={scope.earlier} />{' '}
                    {scope.earlier.length === 1 ? 'keeps what it did' : 'keep what they did'}
                  </>
                )}
                .
              </li>
            )}
            {canRunAgain && first && (
              <li>
                <b>Run again</b> starts a new run from <Ids ids={[first]} />, with factory.yml as it
                is now.
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Step ids in a sentence, as code, listed as a person lists them: `a`, `a and b`, `a, b and c`. */
function Ids({ ids }: { ids: string[] }) {
  return (
    <>
      {ids.map((id, index) => (
        <span key={id}>
          {index === 0 ? '' : index === ids.length - 1 ? ' and ' : ', '}
          <code>{id}</code>
        </span>
      ))}
    </>
  );
}

/** Scroll a step's row into view, move focus to it, and light it once, so the eye lands where the note pointed. */
function revealRow(id: string): void {
  const element = document.getElementById(id);
  if (!element) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  element.focus({ preventScroll: true });
  element.classList.remove('automations-flash');
  void element.offsetWidth;
  element.classList.add('automations-flash');
  element.addEventListener('animationend', () => element.classList.remove('automations-flash'), {
    once: true,
  });
}
