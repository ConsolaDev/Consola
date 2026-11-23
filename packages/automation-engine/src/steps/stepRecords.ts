import {
  flatSteps,
  type RepeatStep,
  type RunRecord,
  type StepEntry,
  type StepRun,
  type StepRunStatus,
} from '@consola/factory-spec';
import type { Lane, StepUpdate } from './sequence';

/*
 * Changes to a steps run's step records, as pure functions: each returns the
 * new list, and `AutomationService` writes it.
 */

/** The lane a step's record waits in: an agent turn's, or a command's. */
export function laneOfRecord(record: Pick<StepRun, 'kind'>): Lane {
  return record.kind === 'agent' ? 'agent' : 'command';
}

/** A run's first records: one per `flatSteps` entry, a loop's row and then its steps', each pending at attempt 1. */
export function stepRecordsOf(entries: readonly StepEntry[]): StepRun[] {
  return flatSteps(entries).map(({ step }) => ({
    id: step.id,
    kind: step.kind,
    status: 'pending',
    attempt: 1,
  }));
}

/** A loop's own row: never a running step, a slot, a stop's target or a stall's witness. */
export function isLoopRow(record: Pick<StepRun, 'kind'>): boolean {
  return record.kind === 'repeat';
}

/** `records` with one step's record changed. */
export function withStep(records: StepRun[], stepId: string, changes: Partial<StepRun>): StepRun[] {
  return records.map((record) => (record.id === stepId ? { ...record, ...changes } : record));
}

/**
 * `records` with one step's attempt starting at `nowIso`: running, and naming
 * no session, conversation or environment until its own launch records them, so an
 * earlier execution's session can never settle it. `agent` is the agent the
 * step runs as, when it names one.
 */
export function withAttemptStarted(
  records: StepRun[],
  stepId: string,
  nowIso: string,
  agent?: string,
): StepRun[] {
  return records.map((record) => {
    if (record.id !== stepId) return record;
    // An earlier attempt's launch (its session, conversation and environment) is not this one's.
    const {
      sessionId: _sessionId,
      conversation: _conversation,
      environment: _environment,
      ...rest
    } = record;
    return {
      ...rest,
      status: 'running',
      startedAt: nowIso,
      ...(agent !== undefined ? { agent } : {}),
    };
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
 * named cleared, so nothing of it can settle or feed the next. Its cost
 * stays, as the remembered attempt's `costUsd` (the run spent it), and its
 * turns as its `turns`. A step that
 * never ran moves on too, `not-run` in its `previous`: its next launch is
 * then never a first attempt, which only a trigger's fire makes. A retry and
 * a restart that runs a step again both go through this.
 */
export function withNextAttempt(
  records: StepRun[],
  stepId: string,
  next: {
    status: 'pending' | 'queued';
    nowIso: string;
    ended?: Omit<EndedAttempt, 'attempt' | 'costUsd' | 'turns'>;
  },
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
      turn,
      model: _model,
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
      ...(turn?.costUsd !== undefined ? { costUsd: turn.costUsd } : {}),
      ...(turn?.turns !== undefined ? { turns: turn.turns } : {}),
      // Inside a loop, the round it ran in; a gate's, the answer it was given.
      ...(record.round !== undefined ? { round: record.round } : {}),
      ...(record.gate?.decision !== undefined ? { decision: record.gate.decision } : {}),
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
 * What an answer, a wait and a note belong to: one execution. A new round, a
 * person's Retry (a new approval) and the entry's own restart each drop them.
 */
function withoutExecutionMarks(record: StepRun): StepRun {
  const { gate: _gate, retryAt: _retryAt, retries: _retries, note: _note, ...rest } = record;
  return rest;
}

/**
 * Round `round` of `block` begins: its row `running` with `round` and `max`.
 * At round 1 each inner row gets `round: 1`. After that, each inner row not
 * `pending` moves to its next attempt (`withNextAttempt`, `pending`; its
 * `previous` line keeps the round it ran in and, for a gate, its decision),
 * and every inner row gets `round`, losing its gate, wait and note (review
 * M2: `withNextAttempt` keeps fields it does not know, so without this a
 * round-2 gate would still carry round 1's answer).
 */
export function withRound(
  records: StepRun[],
  block: RepeatStep,
  round: number,
  nowIso: string,
): StepRun[] {
  const inner = new Set(block.steps.map((step) => step.id));
  let next = records;
  if (round > 1) {
    for (const record of records) {
      if (inner.has(record.id) && record.status !== 'pending')
        next = withNextAttempt(next, record.id, { status: 'pending', nowIso });
    }
  }
  return next.map((record) => {
    if (record.id === block.id) {
      const { gate: _gate, note: _note, ...rest } = record;
      return { ...rest, status: 'running', round, max: block.max };
    }
    if (inner.has(record.id)) return { ...withoutExecutionMarks(record), round };
    return record;
  });
}

/** A gate's row, or a loop's row at its exhaustion gate, parks: `waiting`, asked at `nowIso`. */
export function withGateAsked(records: StepRun[], stepId: string, nowIso: string): StepRun[] {
  return withStep(records, stepId, { status: 'waiting', gate: { askedAt: nowIso } });
}

/**
 * A person answered the gate `stepId` waits at: `completed` at `nowIso`, its
 * `gate` saying what, by whom and when. A gate row's choice is also its
 * `decision` output; a reject, and a loop's exhaustion gate, have none.
 */
export function withGateAnswered(
  records: StepRun[],
  stepId: string,
  answer: { decision: string; nowIso: string; note?: string },
): StepRun[] {
  return records.map((record) => {
    if (record.id !== stepId) return record;
    const output = record.kind === 'gate' && answer.decision !== 'reject';
    return {
      ...record,
      status: 'completed',
      finishedAt: answer.nowIso,
      gate: {
        askedAt: record.gate?.askedAt ?? answer.nowIso,
        decision: answer.decision,
        by: 'person',
        at: answer.nowIso,
      },
      ...(output ? { outputs: { decision: answer.decision } } : {}),
      ...(answer.note !== undefined ? { note: answer.note } : {}),
    };
  });
}

/** A failed step waits out its declared retry: `waiting` until `retryAtIso`, one more retry used, its error kept. */
export function withRetryWait(records: StepRun[], stepId: string, retryAtIso: string): StepRun[] {
  return records.map((record) =>
    record.id === stepId
      ? { ...record, status: 'waiting', retryAt: retryAtIso, retries: (record.retries ?? 0) + 1 }
      : record,
  );
}

/**
 * Its wait is over: the step's next attempt, `pending`, its `previous` line
 * `failed` with the attempt's error. `retryAt` goes; `retries` (what the
 * declared retry counts) and `round` stay.
 */
export function withRetryDue(records: StepRun[], stepId: string, nowIso: string): StepRun[] {
  const record = records.find((candidate) => candidate.id === stepId);
  if (!record) return records;
  return withNextAttempt(records, stepId, {
    status: 'pending',
    nowIso,
    ended: { status: 'failed', error: record.error, finishedAt: record.finishedAt },
  }).map((row) => {
    if (row.id !== stepId) return row;
    const { retryAt: _retryAt, ...rest } = row;
    return rest;
  });
}

/**
 * The entry's declared retry starts the run again: every row not `pending`
 * moves to its next attempt, `pending`; every row loses its gate, wait, note
 * and round, and a loop's row its `max`, so the run begins as new.
 */
export function restartSteps(records: StepRun[], nowIso: string): StepRun[] {
  let next = records;
  for (const record of records) {
    if (record.status !== 'pending')
      next = withNextAttempt(next, record.id, { status: 'pending', nowIso });
  }
  return next.map((record) => {
    const { round: _round, max: _max, ...rest } = withoutExecutionMarks(record);
    return rest;
  });
}

/** A `waiting` run that holds its item and its checkout: at a gate, a loop's exhaustion gate, or a declared retry (a step's or the run's). */
export function holdsWhileWaiting(run: Pick<RunRecord, 'status' | 'steps' | 'retryAt'>): boolean {
  if (run.status !== 'waiting') return false;
  if (run.retryAt !== undefined) return true;
  return (run.steps ?? []).some(
    (record) =>
      record.status === 'waiting' && (record.gate !== undefined || record.retryAt !== undefined),
  );
}

/** The row a `waiting` run waits at for a person, if it does: a gate's, or a loop's at its exhaustion gate. */
export function waitingGateOf(run: Pick<RunRecord, 'status' | 'steps'>): StepRun | undefined {
  if (run.status !== 'waiting') return undefined;
  return (run.steps ?? []).find(
    (record) => record.status === 'waiting' && record.gate !== undefined,
  );
}

/**
 * The step a failed run retries from: the step it failed at (a failed leaf
 * before the failed row of the loop it is in), else a failed loop's row (it
 * ran out of rounds, or a stop failed it between rounds), else (it ended
 * before reaching one, its checkout refused, say) the first it did not run.
 * The renderer's copy (`runPage.ts`) reads the same, by the parity test.
 */
export function retryTargetOf(records: StepRun[]): StepRun | undefined {
  return (
    records.find((record) => record.status === 'failed' && !isLoopRow(record)) ??
    records.find((record) => record.status === 'failed') ??
    records.find((record) => record.status === 'not-run')
  );
}

/**
 * `records` as a retry from `stepId` leaves them, every row the run ended
 * before (`not-run`) after it pending again, earlier ones as they were:
 * - a leaf: its next attempt, pending, for the sequencer to queue; inside a
 *   loop, the loop's row back to `running` in the same round (a retry never
 *   adds a round);
 * - a loop's row (out of rounds, or failed by a stop): one more round,
 *   `(round ?? 0) + 1`, so a loop stopped before its first round starts it.
 * Either way the retried row loses its gate, wait and note: a person's Retry
 * is a new approval (Call 8, review M2). `entries` is the run's definition.
 */
export function retrySteps(
  records: StepRun[],
  stepId: string,
  nowIso: string,
  entries: readonly StepEntry[],
): StepRun[] {
  const from = records.findIndex((record) => record.id === stepId);
  const target = records[from];
  if (!target) return records;
  const flat = flatSteps(entries);
  const reopen = (record: StepRun): StepRun => {
    const { error: _error, finishedAt: _finishedAt, ...rest } = withoutExecutionMarks(record);
    return { ...rest, status: 'running' };
  };
  let next: StepRun[];
  if (isLoopRow(target)) {
    const block = flat.find(
      (row): row is { step: RepeatStep; path: Array<number | 'steps'> } =>
        row.step.kind === 'repeat' && row.step.id === stepId,
    )?.step;
    if (!block) return records;
    next = withRound(records, block, (target.round ?? 0) + 1, nowIso).map((record) =>
      record.id === stepId ? reopen(record) : record,
    );
  } else {
    const block = flat.find((row) => row.step.id === stepId)?.block;
    next = withNextAttempt(records, stepId, { status: 'pending', nowIso }).map((record) =>
      record.id === stepId
        ? withoutExecutionMarks(record)
        : block && record.id === block.id
          ? reopen(record)
          : record,
    );
  }
  return next.map((record, index) =>
    index > from && record.status === 'not-run' ? { ...record, status: 'pending' } : record,
  );
}

/** What a run had not reached when it ended: not started, or waiting for a slot. */
const NOT_REACHED: readonly StepRunStatus[] = ['pending', 'queued'];

/** What a loop's row is while its run goes on: in a round, or at its exhaustion gate. */
const LOOP_OPEN: readonly StepRunStatus[] = ['running', 'waiting'];

/**
 * A run's steps as it ends: `updates` applied, then every step it had not
 * reached marked `not-run` ("the run ended first"), and a loop's row still
 * open taking the run's `ending`: `failed` for a failed run, else
 * `completed` (Call 4). Every path that ends a steps run records its steps
 * through this.
 */
export function closeSteps(
  records: StepRun[],
  nowIso: string,
  updates: StepUpdate[] = [],
  ending: 'completed' | 'failed' | 'rejected' = 'failed',
): StepRun[] {
  const updated = updates.reduce((current, update) => withUpdate(current, update, nowIso), records);
  return updated.map((record) => {
    if (NOT_REACHED.includes(record.status)) return { ...record, status: 'not-run' };
    if (isLoopRow(record) && LOOP_OPEN.includes(record.status))
      return {
        ...record,
        status: ending === 'failed' ? 'failed' : 'completed',
        finishedAt: record.finishedAt ?? nowIso,
      };
    return record;
  });
}
