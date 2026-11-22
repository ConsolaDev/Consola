import type { RunRecord } from '@consola/factory-spec';
import { isLoopRow } from './stepRecords';

/*
 * What a person's stop does to a `steps:` run, decided from its record and
 * whether something is starting that the stop cannot reach yet. Pure:
 * `AutomationService` carries it out. Every case ends with the steps the run
 * had not reached `not-run` (`closeSteps`), however the run ends.
 */

/** A step the run ended before: it never started. */
export function stoppedBefore(stepId: string): string {
  return `Stopped before ${stepId} started.`;
}

/**
 * A loop the run ended between its rounds: its round `round` was over and
 * the next (or its exhaustion gate) not begun (review S8). Before round 1 a
 * loop takes `stoppedBefore`, as any step.
 */
export function stoppedAfterRound(round: number, loopId: string): string {
  return `Stopped after round ${round} of ${loopId}.`;
}

/** What a stop says when the step's session had no turn running to end. */
export const NO_TURN_TO_STOP = 'Stopped: its session was no longer running.';

/** A run stopped while a gate (or a loop's exhaustion gate) waited for a person: that row's error, and the run's. */
export const STOPPED_WAITING_GATE = 'Stopped while it waited for you.';

/** A run stopped while it waited out a declared retry: the run's error (the waiting step keeps its own failure). */
export const STOPPED_BEFORE_RETRY = 'Stopped before its retry.';

export type StopAction =
  /** It ended already: left as it ended. */
  | { kind: 'none' }
  /** Waiting for a person, or in line: dismissed, as a person's Dismiss does. */
  | { kind: 'dismiss' }
  /** Its checkout is being prepared, or its step's session launched, resumed or reminded: stopped once that settles. */
  | { kind: 'defer' }
  /** An agent turn is running: ended as Ctrl+C would, and its end fails the step. */
  | { kind: 'end-turn'; stepId: string; sessionId: string }
  /** A command is running: its process group is stopped, and its result fails the step. */
  | { kind: 'stop-command'; stepId: string }
  /** Nothing is running that could report: the step fails now. */
  | { kind: 'fail-step'; stepId: string; error: string }
  /** Between steps: the run fails now, at the step it would start next. */
  | { kind: 'fail-next' }
  /**
   * A waiting run: it fails with `error`. `stepId` names the row it waited at: a gate's row, or a loop's row at its
   * exhaustion gate, which fails with `error`; or a step waiting out its declared retry, which goes back to `failed`
   * keeping its own error (its `retryAt` dropped), so the failure that caused the wait stays on the record. No `stepId`:
   * the run waited out the entry's own retry (`RunRecord.retryAt`), whose rows stay as they are (a failed row keeps its
   * error; a checkout that could not be prepared left none failed), and `finish` closes the rest `not-run` (review S9).
   */
  | { kind: 'end-wait'; stepId?: string; error: string };

/**
 * The stop of a steps run. `starting` says the run has a checkout preparation,
 * a launch, a resume or a reminder in flight: no process a stop could reach
 * exists yet, so the stop waits for it.
 */
export function stopAction(run: RunRecord, inFlight: { starting: boolean }): StopAction {
  if (run.status === 'needs-approval' || run.status === 'queued') return { kind: 'dismiss' };
  if (run.status === 'waiting') return endWait(run);
  if (run.status !== 'running') return { kind: 'none' };
  if (inFlight.starting) return { kind: 'defer' };
  // A loop's own row runs nothing: what a stop reaches inside a loop is the step running in its round.
  const steps = (run.steps ?? []).filter((step) => !isLoopRow(step));
  const running = steps.find((step) => step.status === 'running');
  if (running?.kind === 'agent') {
    // Every launch is in flight until it names its session, so one without is a turn nothing can end.
    return running.sessionId
      ? { kind: 'end-turn', stepId: running.id, sessionId: running.sessionId }
      : { kind: 'fail-step', stepId: running.id, error: NO_TURN_TO_STOP };
  }
  if (running) return { kind: 'stop-command', stepId: running.id };
  // Waiting for a slot, or for its environment while its command is readied: nothing has run.
  const queued = steps.find((step) => step.status === 'queued');
  if (queued) return { kind: 'fail-step', stepId: queued.id, error: stoppedBefore(queued.id) };
  return { kind: 'fail-next' };
}

/**
 * What a stop does to a run parked with no process: at a gate's row (a loop's
 * row at its exhaustion gate included), at a step waiting out its declared
 * retry, or, failing both, at the entry's own retry wait.
 */
function endWait(run: RunRecord): StopAction {
  const steps = run.steps ?? [];
  const gate = steps.find((step) => step.status === 'waiting' && step.gate !== undefined);
  if (gate) return { kind: 'end-wait', stepId: gate.id, error: STOPPED_WAITING_GATE };
  const retry = steps.find((step) => step.status === 'waiting' && step.retryAt !== undefined);
  if (retry) return { kind: 'end-wait', stepId: retry.id, error: STOPPED_BEFORE_RETRY };
  return { kind: 'end-wait', error: STOPPED_BEFORE_RETRY };
}
