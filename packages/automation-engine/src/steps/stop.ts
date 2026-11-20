import type { RunRecord } from '@consola/factory-spec';

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

/** What a stop says when the step's session had no turn running to end. */
export const NO_TURN_TO_STOP = 'Stopped: its session was no longer running.';

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
  | { kind: 'fail-next' };

/**
 * The stop of a steps run. `starting` says the run has a checkout preparation,
 * a launch, a resume or a reminder in flight: no process a stop could reach
 * exists yet, so the stop waits for it.
 */
export function stopAction(run: RunRecord, inFlight: { starting: boolean }): StopAction {
  if (run.status === 'needs-approval' || run.status === 'queued') return { kind: 'dismiss' };
  if (run.status !== 'running') return { kind: 'none' };
  if (inFlight.starting) return { kind: 'defer' };
  const steps = run.steps ?? [];
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
