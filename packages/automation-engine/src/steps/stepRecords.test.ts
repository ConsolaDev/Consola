import { describe, expect, it } from 'vitest';
import type {
  AgentStep,
  CommandStep,
  GateStep,
  RepeatStep,
  StepEntry,
  StepRun,
} from '@consola/factory-spec';
import {
  closeSteps,
  holdsWhileWaiting,
  isLoopRow,
  restartSteps,
  retrySteps,
  retryTargetOf,
  stepRecordsOf,
  waitingGateOf,
  withAttemptStarted,
  withGateAnswered,
  withGateAsked,
  withNextAttempt,
  withRetryDue,
  withRetryWait,
  withRound,
  withStep,
} from './stepRecords';

const AT = '2026-11-22T08:00:00.000Z';

const records = (): StepRun[] => [
  {
    id: 'look',
    kind: 'agent',
    status: 'queued',
    attempt: 1,
    sessionId: 'session-old',
    conversation: { harnessId: 'claude', id: 'conversation-old' },
  },
  { id: 'tell', kind: 'agent', status: 'pending', attempt: 1 },
];

describe('withAttemptStarted', () => {
  it('records the agent the step runs as', () => {
    const [look, tell] = withAttemptStarted(records(), 'look', AT, 'investigator');
    expect(look).toEqual({
      id: 'look',
      kind: 'agent',
      status: 'running',
      attempt: 1,
      startedAt: AT,
      agent: 'investigator',
    });
    expect(tell).toEqual(records()[1]);
  });

  it('writes no agent without one', () => {
    const [look] = withAttemptStarted(records(), 'look', AT);
    expect(look).toEqual({
      id: 'look',
      kind: 'agent',
      status: 'running',
      attempt: 1,
      startedAt: AT,
    });
    expect(Object.prototype.hasOwnProperty.call(look, 'agent')).toBe(false);
  });

  it("drops an earlier attempt's launch environment: only this attempt's launch records one (slice 3-B)", () => {
    const earlier = records().map((record) =>
      record.id === 'look'
        ? {
            ...record,
            environment: {
              name: 'sandboxed',
              isolation: 'sandbox' as const,
              cliVersion: '2.1.329',
            },
          }
        : record,
    );
    const [look] = withAttemptStarted(earlier, 'look', AT);
    expect(look).not.toHaveProperty('environment');
  });
});

// --- slice 3: loops, gates and retry waits (Task 6) ---------------------------

const T0 = '2026-11-22T09:00:00.000Z';
const T1 = '2026-11-22T09:05:00.000Z';
const T2 = '2026-11-22T09:10:00.000Z';

const agent = (id: string, extra: Partial<AgentStep> = {}): AgentStep => ({
  kind: 'agent',
  id,
  named: true,
  prompt: `Do ${id}.`,
  outputs: {},
  artifacts: [],
  reads: [],
  handover: 'optional',
  ...extra,
});
const command = (id: string, extra: Partial<CommandStep> = {}): CommandStep => ({
  kind: 'run',
  id,
  named: true,
  run: 'echo',
  env: {},
  outputs: {},
  timeoutMs: 600_000,
  dryRun: 'report',
  ...extra,
});
const gate = (id: string, extra: Partial<GateStep> = {}): GateStep => ({
  kind: 'gate',
  id,
  named: true,
  ask: 'Post it?',
  show: [],
  ...extra,
});

/** `polish`: a block of `review` and `address`, three rounds at most. */
const POLISH: RepeatStep = {
  kind: 'repeat',
  id: 'polish',
  named: true,
  max: 3,
  until: 'steps.review.findings == 0',
  steps: [
    agent('review', { outputs: { findings: { type: 'integer' } } }),
    agent('address', { if: 'steps.review.findings > 0' }),
  ],
};
const ENTRIES: StepEntry[] = [agent('fix'), POLISH, command('pr')];
/** A gate inside the loop, asked each round. */
const POLISH_GATED: RepeatStep = { ...POLISH, steps: [...POLISH.steps, gate('decide2')] };
const GATED_ENTRIES: StepEntry[] = [agent('fix'), POLISH_GATED, command('pr')];
/** The gated review's head: a check, a review, a gate. */
const RECORDS: StepRun[] = stepRecordsOf([command('fresh'), agent('review'), gate('decide')]);

const byId = (rows: StepRun[], id: string): StepRun => {
  const found = rows.find((row) => row.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};

/** Round `k` of polish, each inner row completed in it (`fix` done before the loop). */
function afterRound(k: number, entries: StepEntry[] = ENTRIES, block = POLISH): StepRun[] {
  let rows = withStep(stepRecordsOf(entries), 'fix', { status: 'completed' });
  for (let round = 1; round <= k; round++) {
    rows = withRound(rows, block, round, T0);
    for (const inner of block.steps)
      rows = withStep(rows, inner.id, { status: 'completed', finishedAt: T0 });
  }
  return rows;
}

describe('stepRecordsOf', () => {
  it('lays out records in record order', () => {
    expect(stepRecordsOf(ENTRIES).map((r) => [r.id, r.kind, r.status, r.attempt])).toEqual([
      ['fix', 'agent', 'pending', 1],
      ['polish', 'repeat', 'pending', 1],
      ['review', 'agent', 'pending', 1],
      ['address', 'agent', 'pending', 1],
      ['pr', 'run', 'pending', 1],
    ]);
  });

  it('writes nothing but id, kind, status and attempt, so a run with no loop records as before', () => {
    expect(stepRecordsOf([agent('look'), command('tell')])).toEqual([
      { id: 'look', kind: 'agent', status: 'pending', attempt: 1 },
      { id: 'tell', kind: 'run', status: 'pending', attempt: 1 },
    ]);
  });
});

describe('withRound', () => {
  it('round 1 marks the round; round 2 moves each inner step that ran to its next attempt', () => {
    const r1 = withRound(stepRecordsOf(ENTRIES), POLISH, 1, T0);
    expect(byId(r1, 'polish')).toMatchObject({ status: 'running', round: 1, max: 3 });
    expect(byId(r1, 'review')).toMatchObject({ status: 'pending', attempt: 1, round: 1 });
    expect(byId(r1, 'fix')).toEqual({ id: 'fix', kind: 'agent', status: 'pending', attempt: 1 });
    const ran = withStep(
      withStep(r1, 'review', { status: 'completed', outputs: { findings: 1 } }),
      'address',
      { status: 'skipped', skipped: 'x', retries: 1, note: 'n' },
    );
    const r2 = withRound(ran, POLISH, 2, T1);
    expect(byId(r2, 'review')).toMatchObject({
      status: 'pending',
      attempt: 2,
      round: 2,
      previous: [{ attempt: 1, status: 'completed', round: 1 }],
    });
    expect(byId(r2, 'review').outputs).toBeUndefined();
    expect(byId(r2, 'address')).not.toHaveProperty('retries');
    expect(byId(r2, 'address')).not.toHaveProperty('note');
    expect(byId(r2, 'address')).not.toHaveProperty('skipped');
    expect(byId(r2, 'polish')).toMatchObject({ round: 2, max: 3 });
    expect(byId(r2, 'pr')).toEqual(byId(ran, 'pr'));
  });

  it('leaves an inner step that did not run this round where it is, but in the new round', () => {
    const r1 = withRound(stepRecordsOf(ENTRIES), POLISH, 1, T0);
    const r2 = withRound(withStep(r1, 'review', { status: 'completed' }), POLISH, 2, T1);
    expect(byId(r2, 'address')).toEqual({
      id: 'address',
      kind: 'agent',
      status: 'pending',
      attempt: 1,
      round: 2,
    });
  });

  it("a gate inside a loop asks afresh each round, and its previous line keeps the round's decision (review M2)", () => {
    const r1 = withRound(
      withStep(stepRecordsOf(GATED_ENTRIES), 'fix', { status: 'completed' }),
      POLISH_GATED,
      1,
      T0,
    );
    const answered = withGateAnswered(withGateAsked(r1, 'decide2', T0), 'decide2', {
      decision: 'approve',
      nowIso: T1,
    });
    const r2 = withRound(answered, POLISH_GATED, 2, T2);
    expect(byId(r2, 'decide2')).toEqual({
      id: 'decide2',
      kind: 'gate',
      status: 'pending',
      attempt: 2,
      round: 2,
      previous: [
        { attempt: 1, status: 'completed', finishedAt: T1, round: 1, decision: 'approve' },
      ],
    });
  });
});

describe('gates', () => {
  it('a gate asks, then a choice completes it with its decision', () => {
    const asked = withGateAsked(RECORDS, 'decide', T0);
    expect(byId(asked, 'decide')).toMatchObject({ status: 'waiting', gate: { askedAt: T0 } });
    expect(
      byId(withGateAnswered(asked, 'decide', { decision: 'comment', nowIso: T1 }), 'decide'),
    ).toMatchObject({
      status: 'completed',
      finishedAt: T1,
      outputs: { decision: 'comment' },
      gate: { askedAt: T0, decision: 'comment', by: 'person', at: T1 },
    });
    const rejected = byId(
      withGateAnswered(asked, 'decide', { decision: 'reject', nowIso: T1 }),
      'decide',
    );
    expect(rejected.outputs).toBeUndefined();
    expect(rejected.gate).toEqual({ askedAt: T0, decision: 'reject', by: 'person', at: T1 });
    expect(byId(asked, 'review')).toEqual(byId(RECORDS, 'review'));
  });

  it("a loop's exhaustion gate records the answer on its row, with a note and no output", () => {
    const parked = withGateAsked(afterRound(3), 'polish', T0);
    expect(byId(parked, 'polish')).toMatchObject({
      status: 'waiting',
      round: 3,
      gate: { askedAt: T0 },
    });
    const approved = byId(
      withGateAnswered(parked, 'polish', {
        decision: 'approve',
        nowIso: T1,
        note: 'you approved after 3 rounds',
      }),
      'polish',
    );
    expect(approved).toMatchObject({
      status: 'completed',
      note: 'you approved after 3 rounds',
      gate: { decision: 'approve', by: 'person', at: T1 },
    });
    expect(approved.outputs).toBeUndefined();
  });

  it('names the row a waiting run waits at for a person', () => {
    expect(
      waitingGateOf({ status: 'waiting', steps: withGateAsked(RECORDS, 'decide', T0) })?.id,
    ).toBe('decide');
    expect(
      waitingGateOf({ status: 'waiting', steps: withGateAsked(afterRound(3), 'polish', T0) })?.id,
    ).toBe('polish');
    expect(
      waitingGateOf({ status: 'running', steps: withGateAsked(RECORDS, 'decide', T0) }),
    ).toBeUndefined();
    expect(
      waitingGateOf({ status: 'waiting', steps: withRetryWait(RECORDS, 'review', T1) }),
    ).toBeUndefined();
  });
});

describe('retry waits', () => {
  it('a retry waits, then its next attempt keeps its round and count', () => {
    const failed = withStep(withRound(stepRecordsOf(ENTRIES), POLISH, 1, T0), 'review', {
      status: 'failed',
      error: 'exit 1',
      finishedAt: T0,
      sessionId: 'session-1',
    });
    const waiting = withRetryWait(failed, 'review', T1);
    expect(byId(waiting, 'review')).toMatchObject({
      status: 'waiting',
      retryAt: T1,
      retries: 1,
      error: 'exit 1',
      round: 1,
    });
    const due = byId(withRetryDue(waiting, 'review', T1), 'review');
    expect(due).toMatchObject({ status: 'pending', attempt: 2, retries: 1, round: 1 });
    expect(due.previous).toEqual([
      { attempt: 1, status: 'failed', error: 'exit 1', finishedAt: T0, round: 1 },
    ]);
    expect(due).not.toHaveProperty('retryAt');
    expect(due).not.toHaveProperty('error');
    expect(due).not.toHaveProperty('sessionId');
    // A second wait counts on.
    expect(
      byId(withRetryWait(withRetryDue(waiting, 'review', T1), 'review', T2), 'review').retries,
    ).toBe(2);
  });

  it('holds while waiting at a gate or a retry, not otherwise', () => {
    expect(
      holdsWhileWaiting({ status: 'waiting', steps: withGateAsked(RECORDS, 'decide', T0) }),
    ).toBe(true);
    expect(
      holdsWhileWaiting({ status: 'waiting', steps: withGateAsked(afterRound(3), 'polish', T0) }),
    ).toBe(true);
    expect(
      holdsWhileWaiting({ status: 'waiting', steps: withRetryWait(RECORDS, 'review', T1) }),
    ).toBe(true);
    expect(holdsWhileWaiting({ status: 'waiting', steps: [], retryAt: T1 })).toBe(true);
    expect(
      holdsWhileWaiting({ status: 'running', steps: withGateAsked(RECORDS, 'decide', T0) }),
    ).toBe(false);
    expect(holdsWhileWaiting({ status: 'running', steps: [], retryAt: T1 })).toBe(false);
    // A waiting run with nothing it waits at, a later slice's wait, holds nothing here.
    expect(holdsWhileWaiting({ status: 'waiting', steps: RECORDS })).toBe(false);
  });
});

describe('retryTargetOf and retrySteps, with loops', () => {
  /** Round 2 of polish under way: `review` done in it, `address` next. */
  const round2 = withStep(withRound(afterRound(1), POLISH, 2, T1), 'review', {
    status: 'completed',
    outputs: { findings: 1 },
  });

  it('prefers a failed leaf to its failed loop row, then a failed loop row, then the first not-run', () => {
    const failedInner = withStep(
      withStep(round2, 'address', { status: 'failed', error: 'x' }),
      'polish',
      {
        status: 'failed',
      },
    );
    expect(retryTargetOf(failedInner)?.id).toBe('address');
    const exhausted = withStep(afterRound(3), 'polish', {
      status: 'failed',
      error: 'polish: not clean after 3 rounds',
    });
    expect(retryTargetOf(withStep(exhausted, 'pr', { status: 'not-run' }))?.id).toBe('polish');
    const between = withStep(withStep(afterRound(1), 'polish', { status: 'completed' }), 'pr', {
      status: 'not-run',
    });
    expect(retryTargetOf(between)?.id).toBe('pr');
  });

  it('retries a failed inner step in its round, and an exhausted loop one more round', () => {
    const failedInner = withStep(
      withStep(round2, 'address', { status: 'failed', error: 'x', retries: 1, note: 'n' }),
      'polish',
      { status: 'failed', finishedAt: T1 },
    );
    const closed = closeSteps(failedInner, T1);
    expect(byId(closed, 'pr').status).toBe('not-run');
    const retried = retrySteps(closed, 'address', T2, ENTRIES);
    expect(byId(retried, 'polish')).toMatchObject({ status: 'running', round: 2, max: 3 });
    expect(byId(retried, 'polish')).not.toHaveProperty('finishedAt');
    expect(byId(retried, 'address')).toMatchObject({
      status: 'pending',
      round: 2,
      attempt: 3,
      previous: [
        { attempt: 1, status: 'completed', round: 1 },
        { attempt: 2, status: 'failed', error: 'x', round: 2 },
      ],
    });
    expect(byId(retried, 'address')).not.toHaveProperty('retries');
    expect(byId(retried, 'address')).not.toHaveProperty('note');
    expect(byId(retried, 'review')).toEqual(byId(closed, 'review'));
    expect(byId(retried, 'pr').status).toBe('pending');

    const exhausted = closeSteps(
      withStep(afterRound(3), 'polish', {
        status: 'failed',
        error: 'polish: not clean after 3 rounds',
      }),
      T1,
    );
    const again = retrySteps(exhausted, 'polish', T2, ENTRIES);
    expect(byId(again, 'polish')).toMatchObject({ status: 'running', round: 4, max: 3 });
    expect(byId(again, 'polish')).not.toHaveProperty('error');
    expect(byId(again, 'polish')).not.toHaveProperty('finishedAt');
    expect(byId(again, 'review')).toMatchObject({ status: 'pending', round: 4, attempt: 4 });
    expect(byId(again, 'pr').status).toBe('pending');
    expect(byId(again, 'fix')).toEqual(byId(exhausted, 'fix'));
  });

  it('retries a loop a stop failed before its first round from round 1', () => {
    const stopped = closeSteps(
      withStep(withStep(stepRecordsOf(ENTRIES), 'fix', { status: 'completed' }), 'polish', {
        status: 'failed',
        error: 'Stopped before polish started.',
      }),
      T1,
    );
    expect(byId(stopped, 'review').status).toBe('not-run');
    const retried = retrySteps(stopped, 'polish', T2, ENTRIES);
    expect(byId(retried, 'polish')).toMatchObject({ status: 'running', round: 1, max: 3 });
    expect(byId(retried, 'review')).toEqual({
      id: 'review',
      kind: 'agent',
      status: 'pending',
      attempt: 1,
      round: 1,
    });
    expect(byId(retried, 'pr').status).toBe('pending');
  });

  it("a person's retry of a top-level step loses its waits and notes, as a new approval (review M2)", () => {
    const failed = closeSteps(
      withStep(RECORDS, 'review', {
        status: 'failed',
        error: 'exit 1',
        retries: 2,
        note: 'n',
        retryAt: T1,
      }),
      T1,
    );
    const retried = byId(
      retrySteps(failed, 'review', T2, [command('fresh'), agent('review'), gate('decide')]),
      'review',
    );
    expect(retried).toMatchObject({ status: 'pending', attempt: 2 });
    for (const key of ['retries', 'note', 'retryAt', 'gate', 'error'])
      expect(retried).not.toHaveProperty(key);
  });

  it('retries a step with no loop exactly as before', () => {
    const rows: StepRun[] = [
      { id: 'a', kind: 'agent', status: 'completed', attempt: 1 },
      { id: 'b', kind: 'run', status: 'failed', attempt: 1, error: 'exit 1' },
      { id: 'c', kind: 'agent', status: 'not-run', attempt: 1 },
    ];
    expect(retrySteps(rows, 'b', T2, [agent('a'), command('b'), agent('c')])).toEqual([
      { id: 'a', kind: 'agent', status: 'completed', attempt: 1 },
      {
        id: 'b',
        kind: 'run',
        status: 'pending',
        attempt: 2,
        previous: [{ attempt: 1, status: 'failed', error: 'exit 1' }],
      },
      { id: 'c', kind: 'agent', status: 'pending', attempt: 1 },
    ]);
  });
});

describe('closeSteps, with loops', () => {
  it("closes an open loop row by the run's end", () => {
    const running = withRound(
      withStep(stepRecordsOf(ENTRIES), 'fix', { status: 'completed' }),
      POLISH,
      1,
      T0,
    );
    expect(byId(closeSteps(running, T1, [], 'failed'), 'polish')).toMatchObject({
      status: 'failed',
      finishedAt: T1,
    });
    expect(byId(closeSteps(running, T1), 'polish').status).toBe('failed');
    expect(byId(closeSteps(running, T1, [], 'completed'), 'polish').status).toBe('completed');
    expect(byId(closeSteps(running, T1, [], 'rejected'), 'polish').status).toBe('completed');
    const parked = withGateAsked(afterRound(3), 'polish', T0);
    expect(byId(closeSteps(parked, T1, [], 'failed'), 'polish').status).toBe('failed');
    // Its steps the run had not reached are not-run, as any step's.
    expect(byId(closeSteps(running, T1), 'review').status).toBe('not-run');
  });

  it('leaves a loop row that ended alone', () => {
    const done = withStep(afterRound(2), 'polish', {
      status: 'completed',
      note: 'clean after round 2',
    });
    expect(byId(closeSteps(done, T1, [], 'failed'), 'polish')).toEqual(byId(done, 'polish'));
    const skipped = withStep(stepRecordsOf(ENTRIES), 'polish', { status: 'skipped', skipped: 'x' });
    expect(byId(closeSteps(skipped, T1, [], 'failed'), 'polish').status).toBe('skipped');
  });
});

describe('restartSteps', () => {
  it('the entry retry moves every row that ran to its next attempt', () => {
    const failed = closeSteps(
      withStep(withRound(afterRound(1), POLISH, 2, T1), 'review', { status: 'failed', error: 'x' }),
      T1,
    );
    const restarted = restartSteps(failed, T2);
    expect(byId(restarted, 'fix')).toMatchObject({
      status: 'pending',
      attempt: 2,
      previous: [{ attempt: 1, status: 'completed' }],
    });
    expect(byId(restarted, 'polish')).toMatchObject({ status: 'pending', attempt: 2 });
    for (const key of ['round', 'max', 'note'])
      expect(byId(restarted, 'polish')).not.toHaveProperty(key);
    expect(byId(restarted, 'review')).toMatchObject({ status: 'pending', attempt: 3 });
    expect(byId(restarted, 'review')).not.toHaveProperty('round');
    expect(
      byId(restarted, 'review').previous?.map((line) => [line.attempt, line.status, line.round]),
    ).toEqual([
      [1, 'completed', 1],
      [2, 'failed', 2],
    ]);
    // A row that never ran moves too (`withNextAttempt`'s rule): its next launch is never a first attempt.
    expect(byId(restarted, 'pr')).toMatchObject({ status: 'pending', attempt: 2 });
    expect(restarted.every((row) => row.status === 'pending')).toBe(true);
  });

  it("drops each row's waits and answers, keeping a gate's decision in its previous line", () => {
    const answered = withGateAnswered(withGateAsked(RECORDS, 'decide', T0), 'decide', {
      decision: 'approve',
      nowIso: T1,
    });
    const restarted = byId(restartSteps(answered, T2), 'decide');
    expect(restarted).toMatchObject({ status: 'pending', attempt: 2 });
    expect(restarted).not.toHaveProperty('gate');
    expect(restarted).not.toHaveProperty('outputs');
    expect(restarted.previous).toEqual([
      { attempt: 1, status: 'completed', finishedAt: T1, decision: 'approve' },
    ]);
  });
});

describe('isLoopRow', () => {
  it("is a loop's own row only", () => {
    expect(
      stepRecordsOf(ENTRIES)
        .filter(isLoopRow)
        .map((row) => row.id),
    ).toEqual(['polish']);
  });
});

describe('withNextAttempt, with rounds', () => {
  it("keeps the round an attempt ran in and a gate's answer in its previous line", () => {
    const rows = withStep(stepRecordsOf([gate('decide')]), 'decide', {
      status: 'completed',
      round: 2,
      gate: { askedAt: T0, decision: 'comment', by: 'person', at: T1 },
    });
    expect(
      byId(withNextAttempt(rows, 'decide', { status: 'pending', nowIso: T2 }), 'decide').previous,
    ).toEqual([{ attempt: 1, status: 'completed', round: 2, decision: 'comment' }]);
  });
});
