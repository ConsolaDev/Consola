import type { StepRun, StepRunStatus } from '@consola/factory-spec';
import type { Lane, StepUpdate } from './sequence';

/*
 * Changes to a steps run's step records, as pure functions: each returns the
 * new list, and `AutomationService` writes it.
 */

/** The lane a step's record waits in: an agent turn's, or a command's. */
export function laneOfRecord(record: Pick<StepRun, 'kind'>): Lane {
  return record.kind === 'agent' ? 'agent' : 'command';
}

/** `records` with one step's record changed. */
export function withStep(records: StepRun[], stepId: string, changes: Partial<StepRun>): StepRun[] {
  return records.map((record) => (record.id === stepId ? { ...record, ...changes } : record));
}

/**
 * `records` with one step's attempt starting at `nowIso`: running, and naming
 * no session or conversation until its own launch records them, so an
 * earlier execution's session can never settle it.
 */
export function withAttemptStarted(records: StepRun[], stepId: string, nowIso: string): StepRun[] {
  return records.map((record) => {
    if (record.id !== stepId) return record;
    const { sessionId: _sessionId, conversation: _conversation, ...rest } = record;
    return { ...rest, status: 'running', startedAt: nowIso };
  });
}

/** `records` with one of the sequencer's updates applied; a failure ends the step at `nowIso`. */
export function withUpdate(records: StepRun[], update: StepUpdate, nowIso: string): StepRun[] {
  const { id, ...changes } = update;
  return withStep(
    records,
    id,
    update.status === 'failed' ? { ...changes, finishedAt: nowIso } : changes,
  );
}

/** How a step's earlier attempt is remembered in its `previous`. */
export type EndedAttempt = NonNullable<StepRun['previous']>[number];

/**
 * `records` with one step given its next attempt, in a new session and a new
 * folder: its attempt as it ended kept in `previous` (as its record has it,
 * unless `ended` says otherwise), and everything that attempt produced or
 * named cleared, so nothing of it can settle or feed the next. A step that
 * never ran moves on too, `not-run` in its `previous`: its next launch is
 * then never a first attempt, which only a trigger's fire makes. A retry and
 * a restart that runs a step again both go through this.
 */
export function withNextAttempt(
  records: StepRun[],
  stepId: string,
  next: { status: 'pending' | 'queued'; nowIso: string; ended?: Omit<EndedAttempt, 'attempt'> },
): StepRun[] {
  return records.map((record) => {
    if (record.id !== stepId) return record;
    const {
      outputs: _outputs,
      artifacts: _artifacts,
      sessionId: _sessionId,
      conversation: _conversation,
      reminded: _reminded,
      command: _command,
      error,
      finishedAt,
      startedAt: _startedAt,
      queuedAt: _queuedAt,
      skipped: _skipped,
      previous = [],
      ...kept
    } = record;
    const ended = next.ended ?? { status: record.status, error, finishedAt };
    const remembered: EndedAttempt = {
      attempt: record.attempt,
      status: ended.status,
      ...(ended.error !== undefined ? { error: ended.error } : {}),
      ...(ended.finishedAt !== undefined ? { finishedAt: ended.finishedAt } : {}),
    };
    return {
      ...kept,
      status: next.status,
      attempt: record.attempt + 1,
      ...(next.status === 'queued' ? { queuedAt: next.nowIso } : {}),
      previous: [...previous, remembered],
    };
  });
}

/**
 * The step a failed run retries from: the one it failed at, else (it ended
 * before reaching one, its checkout refused, say) the first it did not run.
 */
export function retryTargetOf(records: StepRun[]): StepRun | undefined {
  return (
    records.find((record) => record.status === 'failed') ??
    records.find((record) => record.status === 'not-run')
  );
}

/**
 * `records` as a retry from `stepId` leaves them: that step's next attempt
 * pending, for the sequencer to queue, and every later step the run ended
 * before pending again. Earlier steps keep what they recorded.
 */
export function retrySteps(records: StepRun[], stepId: string, nowIso: string): StepRun[] {
  const from = records.findIndex((record) => record.id === stepId);
  return withNextAttempt(records, stepId, { status: 'pending', nowIso }).map((record, index) =>
    index > from && record.status === 'not-run' ? { ...record, status: 'pending' } : record,
  );
}

/** What a run had not reached when it ended: not started, or waiting for a slot. */
const NOT_REACHED: readonly StepRunStatus[] = ['pending', 'queued'];

/**
 * A run's steps as it ends: `updates` applied, then every step it had not
 * reached marked `not-run` ("the run ended first"). Every path that ends a
 * steps run records its steps through this.
 */
export function closeSteps(
  records: StepRun[],
  nowIso: string,
  updates: StepUpdate[] = [],
): StepRun[] {
  const updated = updates.reduce((current, update) => withUpdate(current, update, nowIso), records);
  return updated.map((record) =>
    NOT_REACHED.includes(record.status) ? { ...record, status: 'not-run' } : record,
  );
}
