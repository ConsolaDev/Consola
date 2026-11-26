import type { RunRecord, StepRun } from '@consola/factory-spec';
import { isLoopRow } from './stepRecords';

/** What a `run:` step says when Consola quit between its intent and its result. */
export const INTERRUPTED_COMMAND =
  'Interrupted: Consola quit while this command was running. It may or may not have finished; check, then retry.';

/**
 * What a write step (its agent `edit` or `write`) says when Consola quit
 * while it ran (slice 3-B): it was changing the run's checkout, and a
 * resumed session would go on from a tree nobody checked.
 */
export const INTERRUPTED_WRITE =
  'Interrupted: Consola quit while this step was changing the checkout. Check it, then retry.';

/** What a `run:` step says when Consola quit after its command finished but before the step was settled. */
export function settleInterrupted(command: { exitCode?: number; signal?: string }): string {
  const how = command.exitCode !== undefined ? `exit ${command.exitCode}` : command.signal;
  return `Consola quit while recording this command's result (${how}). It ran; check what it did, then retry.`;
}

/** What a `uses:` step says when Consola quit between its intent and its answer. */
export const INTERRUPTED_CALL =
  'Interrupted: Consola quit while this call was in flight. It may or may not have happened; check, then retry.';

/** What a `uses:` step says when Consola quit after its answer was recorded but before the step was settled. */
export const CALL_SETTLE_INTERRUPTED =
  "Consola quit while recording this call's result. It happened; check what it did, then retry.";

/** A run the engine drives: an agent run, or a `steps:` run. */
export function isEngineRun(run: RunRecord): boolean {
  const kind = (run.result as { kind?: unknown } | undefined)?.kind;
  return kind === 'agent-run' || kind === 'steps-run';
}

/** A run of a `steps:` entry: the only kind with a run folder. */
export function isStepsRun(run: RunRecord): boolean {
  return (run.result as { kind?: unknown } | undefined)?.kind === 'steps-run';
}

/**
 * What a run that was `running` at quit becomes after a restart: the recovered
 * copy, or null when nothing changes. Pure; the caller records it.
 *
 * Read-only agent work goes back to the line, to resume in its session. A
 * command or a call that declared intent and left no result is never re-run:
 * it may have posted, pushed or moved a ticket, so the run fails and says so,
 * and a loop it was inside, still open, fails with it. So does a write step
 * (its record's `tools`, slice 3-B): it was changing the checkout. A loop's
 * own row is left as it is (its round goes on from the record), and a run
 * `waiting` at a gate or a retry has nothing running: it comes back unchanged.
 */
export function recoverAfterRestart(run: RunRecord, nowIso: string): RunRecord | null {
  if (run.status !== 'running') return null;
  if (!isEngineRun(run)) {
    const { approval: _approval, ...rest } = run;
    return {
      ...rest,
      status: 'failed',
      error: 'Interrupted: Consola quit while this was running.',
      updatedAt: nowIso,
      finishedAt: nowIso,
    };
  }
  if (!run.steps) return { ...run, status: 'queued', updatedAt: nowIso };

  // A command or a call is never re-queued: with intent and no result it may
  // have run; with a result it did, and only the status write was lost. Nor
  // is a write step: it was changing the checkout when Consola quit.
  const cut = run.steps.findIndex(
    (step) => commandCutOff(step) || callCutOff(step) || writeCutOff(step),
  );
  if (cut >= 0) {
    const stopped = run.steps[cut];
    const error = writeCutOff(stopped)
      ? INTERRUPTED_WRITE
      : stopped.kind === 'uses'
        ? stopped.call?.resultAt
          ? CALL_SETTLE_INTERRUPTED
          : INTERRUPTED_CALL
        : commandResulted(stopped)
          ? settleInterrupted(stopped.command!)
          : INTERRUPTED_COMMAND;
    const steps = run.steps.map((step, index): StepRun => {
      if (index === cut) return { ...step, status: 'failed', error, finishedAt: nowIso };
      if (isLoopRow(step) && (step.status === 'running' || step.status === 'waiting')) {
        return { ...step, status: 'failed', finishedAt: nowIso };
      }
      if (index > cut && step.status === 'pending') return { ...step, status: 'not-run' };
      return step;
    });
    const { approval: _approval, ...rest } = run;
    return { ...rest, steps, status: 'failed', error, updatedAt: nowIso, finishedAt: nowIso };
  }

  // Anything else that was running (an agent step, or a command or a call
  // that never declared intent) goes back to the line; the run itself stays
  // running. A loop's row is no work under way: it stays `running` in its round.
  const cutOff = (step: StepRun) => step.status === 'running' && !isLoopRow(step);
  if (!run.steps.some(cutOff)) return null;
  const steps = run.steps.map(
    (step): StepRun => (cutOff(step) ? { ...step, status: 'queued' } : step),
  );
  return { ...run, steps };
}

function commandResulted(step: StepRun): boolean {
  return step.command?.exitCode !== undefined || step.command?.signal !== undefined;
}

/** An agent step whose agent writes (`tools`, written as it starts), cut off while it ran. */
function writeCutOff(step: StepRun): boolean {
  return (
    step.status === 'running' &&
    step.kind === 'agent' &&
    (step.tools === 'edit' || step.tools === 'write')
  );
}

/** A `run:` step that was running with intent declared, whether or not its result was recorded. */
function commandCutOff(step: StepRun): boolean {
  return (
    step.status === 'running' &&
    step.kind === 'run' &&
    (!!step.command?.intentAt || commandResulted(step))
  );
}

/** A `uses:` step that was running with its intent declared (an answer is never recorded without one), whether or not its answer was. */
function callCutOff(step: StepRun): boolean {
  return step.status === 'running' && step.kind === 'uses' && !!step.call?.intentAt;
}
