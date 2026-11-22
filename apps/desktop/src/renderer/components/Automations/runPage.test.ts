import { describe, expect, it } from 'vitest';
import type {
  AgentRunPreview,
  RunRecord,
  StepRun,
  StepsRunPreview,
} from '../../../shared/automations';
import type { ConversationEntry } from '../../../shared/conversation';
import {
  adjacentRuns,
  durationAgainstUsual,
  foundNothingToDo,
  endedWhileRunning,
  isInterruptedCommand,
  leadDetail,
  loopsOf,
  rejectedWords,
  retryTargetOf,
  retryWarningOf,
  runRetryTarget,
  roundsOf,
  runNotes,
  runStages,
  stepBar,
  stopOffered,
  traceRows,
  stepState,
  stepTimeline,
  triggerStageWords,
  toolCounts,
  workedMs,
  type RunStageState,
} from './runPage';
import { rejectedAtGate } from './presentation';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const PREVIEW: AgentRunPreview = { kind: 'agent-run', runs: 'Review action', prompt: 'Review it.' };

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  const createdAt = overrides.createdAt ?? ago(10 * MINUTE);
  return {
    id: 'r1',
    runner: 'local',
    source: 'personal',
    automationId: 'sweep',
    actionName: 'consola#sweep',
    actionVersion: 'v1',
    mode: 'auto',
    trigger: { kind: 'cron', at: createdAt },
    status: 'completed',
    attribution: { automationId: 'sweep', actionName: 'consola#sweep', triggerKind: 'cron' },
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

const agentRecord = (overrides: Partial<RunRecord> = {}) =>
  record({ result: PREVIEW, actionName: 'review', ...overrides });

/** The stages as `key:state`, which is what most cases are about. */
const shape = (run: RunRecord) => runStages(run, NOW).map((stage) => `${stage.key}:${stage.state}`);
const msOf = (run: RunRecord, key: string) =>
  runStages(run, NOW).find((stage) => stage.key === key)?.ms;

describe('runStages', () => {
  it('an auto tool run is its trigger and the run', () => {
    const run = record({ startedAt: ago(10 * MINUTE), finishedAt: ago(10 * MINUTE - 2 * SECOND) });
    expect(shape(run)).toEqual(['trigger:passed', 'run:passed']);
    expect(msOf(run, 'run')).toBe(2 * SECOND);
  });

  it('a confirm tool run previews, waits for a person, then runs; the wait ends when they approve', () => {
    const run = record({
      mode: 'confirm',
      approval: { args: {} },
      approvedAt: ago(6 * MINUTE),
      startedAt: ago(6 * MINUTE),
      finishedAt: ago(6 * MINUTE - SECOND),
    });
    expect(shape(run)).toEqual([
      'trigger:passed',
      'preview:passed',
      'approval:passed',
      'run:passed',
    ]);
    expect(msOf(run, 'approval')).toBe(4 * MINUTE);
  });

  it('an older confirm tool run, without approvedAt, ends its wait at its start', () => {
    const run = record({
      mode: 'confirm',
      approval: { args: {} },
      startedAt: ago(7 * MINUTE),
      finishedAt: ago(7 * MINUTE),
    });
    expect(msOf(run, 'approval')).toBe(3 * MINUTE);
  });

  it('a run waiting for a person stands at approval, counting, with what follows still to come', () => {
    const run = record({ mode: 'confirm', status: 'needs-approval', approval: { args: {} } });
    expect(shape(run)).toEqual([
      'trigger:passed',
      'preview:passed',
      'approval:waiting',
      'run:pending',
    ]);
    expect(msOf(run, 'approval')).toBe(10 * MINUTE);
    expect(msOf(run, 'run')).toBeNull();
  });

  it('a confirm run that found nothing to do ends at its preview', () => {
    const run = record({ mode: 'confirm', finishedAt: ago(10 * MINUTE - SECOND) });
    expect(foundNothingToDo(run)).toBe(true);
    expect(shape(run)).toEqual([
      'trigger:passed',
      'preview:passed',
      'approval:skipped',
      'run:skipped',
    ]);
    expect(msOf(run, 'preview')).toBe(SECOND);
  });

  it('a notify run previews and tells', () => {
    expect(shape(record({ mode: 'notify' }))).toEqual([
      'trigger:passed',
      'preview:passed',
      'notify:passed',
    ]);
    expect(shape(agentRecord({ mode: 'notify' }))).toEqual(['trigger:passed', 'notify:passed']);
  });

  it('a dismissed tool run stopped at approval, and the run was never reached', () => {
    const run = record({
      mode: 'confirm',
      status: 'rejected',
      approval: { args: {} },
      finishedAt: ago(8 * MINUTE),
    });
    expect(shape(run)).toEqual([
      'trigger:passed',
      'preview:passed',
      'approval:stopped',
      'run:skipped',
    ]);
    expect(msOf(run, 'approval')).toBe(2 * MINUTE);
  });

  it('a tool run refused when approved failed at approval; one whose preview threw failed there', () => {
    const refused = record({
      mode: 'confirm',
      status: 'failed',
      approval: { args: {} },
      error: 'Not run: x.',
    });
    expect(shape(refused)).toEqual([
      'trigger:passed',
      'preview:passed',
      'approval:failed',
      'run:skipped',
    ]);
    const threw = record({ mode: 'confirm', status: 'failed', error: 'boom' });
    expect(shape(threw)).toEqual([
      'trigger:passed',
      'preview:failed',
      'approval:skipped',
      'run:skipped',
    ]);
  });

  it('a tool run that failed while running failed in its run', () => {
    const run = record({ status: 'failed', startedAt: ago(MINUTE), finishedAt: ago(0) });
    expect(shape(run)).toEqual(['trigger:passed', 'run:failed']);
    expect(msOf(run, 'run')).toBe(MINUTE);
  });

  it('an approved agent run splits its wait: for the person, then in line', () => {
    const run = agentRecord({
      mode: 'confirm',
      approvedAt: ago(8 * MINUTE),
      startedAt: ago(7 * MINUTE),
      finishedAt: ago(4 * MINUTE),
    });
    expect(shape(run)).toEqual(['trigger:passed', 'approval:passed', 'queue:passed', 'run:passed']);
    expect([msOf(run, 'approval'), msOf(run, 'queue'), msOf(run, 'run')]).toEqual([
      2 * MINUTE,
      MINUTE,
      3 * MINUTE,
    ]);
  });

  it('an older approved agent run cannot split its wait, so neither half has a length', () => {
    const run = agentRecord({
      mode: 'confirm',
      startedAt: ago(7 * MINUTE),
      finishedAt: ago(4 * MINUTE),
    });
    expect([msOf(run, 'approval'), msOf(run, 'queue')]).toEqual([null, null]);
  });

  it('an auto agent run waits in line from when it fired', () => {
    const queued = agentRecord({ status: 'queued' });
    expect(shape(queued)).toEqual(['trigger:passed', 'queue:queued', 'run:pending']);
    expect(msOf(queued, 'queue')).toBe(10 * MINUTE);
    const running = agentRecord({ status: 'running', startedAt: ago(9 * MINUTE) });
    expect(shape(running)).toEqual(['trigger:passed', 'queue:passed', 'run:running']);
    expect([msOf(running, 'queue'), msOf(running, 'run')]).toEqual([MINUTE, 9 * MINUTE]);
  });

  it('a turned-down agent run stopped at approval unless a person had approved it', () => {
    expect(shape(agentRecord({ mode: 'confirm', status: 'rejected' }))).toEqual([
      'trigger:passed',
      'approval:stopped',
      'queue:skipped',
      'run:skipped',
    ]);
    expect(
      shape(agentRecord({ mode: 'confirm', status: 'rejected', approvedAt: ago(5 * MINUTE) })),
    ).toEqual(['trigger:passed', 'approval:passed', 'queue:stopped', 'run:skipped']);
    expect(shape(agentRecord({ status: 'rejected' }))).toEqual([
      'trigger:passed',
      'queue:stopped',
      'run:skipped',
    ]);
  });

  it('an agent run that failed before starting failed in line, or at approval when nobody approved it', () => {
    expect(shape(agentRecord({ status: 'failed' }))).toEqual([
      'trigger:passed',
      'queue:failed',
      'run:skipped',
    ]);
    const refused = agentRecord({ mode: 'confirm', status: 'failed' });
    expect(shape(refused).slice(1, 3)).toEqual(['approval:failed', 'queue:skipped']);
  });

  it('an agent run that failed after starting failed in its session', () => {
    const run = agentRecord({ status: 'failed', startedAt: ago(3 * MINUTE), finishedAt: ago(0) });
    expect(shape(run)).toEqual(['trigger:passed', 'queue:passed', 'run:failed']);
  });

  it('never has a stage both reached and unreached', () => {
    const states: RunStageState[] = runStages(
      record({ mode: 'confirm', status: 'needs-approval' }),
      NOW,
    ).map((s) => s.state);
    expect(states.indexOf('pending')).toBeGreaterThan(states.indexOf('waiting'));
  });
});

describe('workedMs', () => {
  it('counts from the start to the end, to now while running, and not before starting', () => {
    expect(workedMs(record({ startedAt: ago(MINUTE), finishedAt: ago(0) }), NOW)).toBe(MINUTE);
    expect(workedMs(record({ status: 'running', startedAt: ago(MINUTE) }), NOW)).toBe(MINUTE);
    expect(workedMs(record({ status: 'needs-approval' }), NOW)).toBeNull();
  });
});

/** Runs of one automation, newest first, each `ms` long; `f` for failed. */
function history(...specs: Array<number | `f${number}`>): RunRecord[] {
  return specs.map((spec, index) => {
    const failed = typeof spec === 'string';
    const ms = failed ? Number(spec.slice(1)) : spec;
    const start = ago((index + 1) * 60 * MINUTE);
    return record({
      id: `r${index}`,
      status: failed ? 'failed' : 'completed',
      startedAt: start,
      finishedAt: new Date(Date.parse(start) + ms).toISOString(),
    });
  });
}

describe('runNotes', () => {
  it('says a pass after failures is a recovery', () => {
    const runs = history(5000, 'f5000', 'f5000', 5000);
    expect(runNotes(runs[0], runs)).toEqual([
      { tone: 'good', text: 'Passing again after 2 failures' },
    ]);
    const once = history(5000, 'f5000', 5000);
    expect(runNotes(once[0], once)[0].text).toBe('Passing again after a failure');
  });

  it('counts failures in a row, this one included', () => {
    const runs = history('f1', 'f1', 'f1', 5000);
    expect(runNotes(runs[0], runs)).toEqual([{ tone: 'bad', text: '3 failures in a row' }]);
  });

  it('says when a failure breaks a good run of passes, and not after only a couple', () => {
    const runs = history('f1', 5000, 5000, 5000, 5000);
    expect(runNotes(runs[0], runs)).toEqual([
      { tone: 'neutral', text: 'First failure after 4 passing runs' },
    ]);
    const short = history('f1', 5000, 5000);
    expect(runNotes(short[0], short)).toEqual([]);
  });

  it('marks the fastest once there are enough runs to mean it', () => {
    const runs = history(1000, 5000, 4000, 6000, 3000);
    expect(runNotes(runs[0], runs)).toEqual([{ tone: 'good', text: 'Fastest of 5 runs' }]);
    const few = history(1000, 5000, 4000);
    expect(runNotes(few[0], few)).toEqual([]);
    const tie = history(1000, 1000, 4000, 6000, 3000);
    expect(runNotes(tie[0], tie)).toEqual([]);
  });

  it('notes an older run against those before it, not after', () => {
    const runs = history('f1', 5000, 'f1');
    expect(runNotes(runs[1], runs)).toEqual([
      { tone: 'good', text: 'Passing again after a failure' },
    ]);
  });

  it('says nothing about a run that has not ended', () => {
    const runs = [record({ status: 'running', startedAt: ago(MINUTE) }), ...history(5000)];
    expect(runNotes(runs[0], runs)).toEqual([]);
  });
});

describe('durationAgainstUsual', () => {
  it('compares with the middle of the other runs', () => {
    const slow = history(60_000, 20_000, 30_000, 40_000);
    expect(durationAgainstUsual(slow[0], slow, NOW)).toEqual({
      text: '2.0× its usual 30s',
      tone: 'slow',
    });
    const fast = history(10_000, 20_000, 30_000, 40_000);
    expect(durationAgainstUsual(fast[0], fast, NOW)).toEqual({
      text: 'faster than its usual 30s',
      tone: 'fast',
    });
    const usual = history(31_000, 20_000, 30_000, 40_000);
    expect(durationAgainstUsual(usual[0], usual, NOW)).toEqual({
      text: 'usual 30s',
      tone: 'usual',
    });
  });

  it('calls a second or two either way usual, however short the runs', () => {
    const runs = history(2500, 1000, 1000, 1000);
    expect(durationAgainstUsual(runs[0], runs, NOW)?.tone).toBe('usual');
  });

  it('has nothing to say with too few others, or before the run started', () => {
    const few = history(60_000, 20_000, 30_000);
    expect(durationAgainstUsual(few[0], few, NOW)).toBeNull();
    expect(durationAgainstUsual(record({ status: 'queued' }), history(1, 1, 1, 1), NOW)).toBeNull();
  });
});

describe('adjacentRuns', () => {
  it('finds the newer and the older run either side', () => {
    const runs = history(1, 1, 1);
    expect(adjacentRuns('r1', runs)).toEqual({ newer: 'r0', older: 'r2' });
    expect(adjacentRuns('r0', runs)).toEqual({ newer: null, older: 'r1' });
    expect(adjacentRuns('gone', runs)).toEqual({ newer: null, older: null });
  });
});

const step = (tool: string, extra: Partial<Extract<ConversationEntry, { kind: 'step' }>> = {}) =>
  ({ kind: 'step', tool, ...extra }) as Extract<ConversationEntry, { kind: 'step' }>;

describe('toolCounts', () => {
  it('counts each tool, most-called first, ties by name', () => {
    const entries: ConversationEntry[] = [
      step('Read'),
      step('Bash'),
      { kind: 'text', text: 'thinking aloud' },
      step('Read'),
      step('Grep'),
    ];
    expect(toolCounts(entries)).toEqual([
      { tool: 'Read', count: 2 },
      { tool: 'Bash', count: 1 },
      { tool: 'Grep', count: 1 },
    ]);
  });
});

describe('stepState', () => {
  it('reads the result, and an unanswered last step by how the run stands', () => {
    expect(stepState(step('Bash', { endedAt: ago(0), failed: true }), false, 'completed')).toBe(
      'failed',
    );
    expect(stepState(step('Read', { endedAt: ago(0) }), true, 'running')).toBe('passed');
    expect(stepState(step('Read'), true, 'running')).toBe('running');
    expect(stepState(step('Read'), true, 'failed')).toBe('cut');
    expect(stepState(step('Read'), false, 'running')).toBe('unknown');
  });
});

describe('stepTimeline and stepBar', () => {
  const started = ago(100 * SECOND);
  const run = record({ status: 'completed', startedAt: started, finishedAt: ago(0) });

  it('spans the run, and places a step by when it began and how long it took', () => {
    const entry = step('Bash', { at: ago(50 * SECOND), endedAt: ago(25 * SECOND) });
    const timeline = stepTimeline(run, [entry], NOW)!;
    expect(timeline.end - timeline.start).toBe(100 * SECOND);
    expect(stepBar(entry, 'passed', timeline, NOW)).toEqual({
      left: 0.5,
      width: 0.25,
      ms: 25 * SECOND,
    });
  });

  it('reaches a running step to now, and leaves an unanswered one a tick', () => {
    const running = record({ status: 'running', startedAt: started });
    const open = step('Bash', { at: ago(20 * SECOND) });
    const timeline = stepTimeline(running, [open], NOW)!;
    expect(stepBar(open, 'running', timeline, NOW)).toEqual({
      left: 0.8,
      width: expect.closeTo(0.2),
      ms: 20 * SECOND,
    });
    expect(stepBar(open, 'unknown', timeline, NOW)).toEqual({ left: 0.8, width: 0, ms: null });
  });

  it('falls back on the transcript’s own times, and has nothing to draw without any', () => {
    const unstarted = record({ status: 'failed', startedAt: undefined, finishedAt: undefined });
    const entries = [step('Read', { at: ago(30 * SECOND), endedAt: ago(10 * SECOND) })];
    expect(stepTimeline(unstarted, entries, NOW)).toEqual({
      start: NOW.getTime() - 30 * SECOND,
      end: NOW.getTime() - 10 * SECOND,
    });
    expect(stepTimeline(unstarted, [step('Read')], NOW)).toBeNull();
    expect(stepBar(step('Read'), 'unknown', { start: 0, end: 1 }, NOW)).toBeNull();
  });
});

const STEPS_PREVIEW: StepsRunPreview = {
  kind: 'steps-run',
  steps: [],
  scope: 'api',
} as unknown as StepsRunPreview;

function stepOf(overrides: Partial<StepRun> & Pick<StepRun, 'id'>): StepRun {
  return { kind: 'agent', status: 'pending', attempt: 1, ...overrides };
}

const stepsRecord = (steps: StepRun[], overrides: Partial<RunRecord> = {}) =>
  record({ result: STEPS_PREVIEW, steps, ...overrides });

const stepShape = (run: RunRecord) =>
  runStages(run, NOW).map((stage) =>
    stage.step ? `step:${stage.step.id}:${stage.state}` : `${stage.key}:${stage.state}`,
  );
const stepMs = (run: RunRecord, id: string) =>
  runStages(run, NOW).find((stage) => stage.step?.id === id)?.ms;

describe('isInterruptedCommand', () => {
  const interrupted = stepOf({
    id: 'publish',
    kind: 'run',
    status: 'failed',
    command: { envNames: [], intentAt: ago(MINUTE) },
  });

  it('is true for a failed command that recorded its intent and no result', () => {
    expect(isInterruptedCommand(interrupted)).toBe(true);
  });

  it('is false for an agent step, another status, no intent, or a result', () => {
    expect(isInterruptedCommand({ ...interrupted, kind: 'agent' })).toBe(false);
    expect(isInterruptedCommand({ ...interrupted, status: 'completed' })).toBe(false);
    expect(isInterruptedCommand({ ...interrupted, command: { envNames: [] } })).toBe(false);
    expect(
      isInterruptedCommand({
        ...interrupted,
        command: { envNames: [], intentAt: ago(MINUTE), exitCode: 1 },
      }),
    ).toBe(false);
    expect(
      isInterruptedCommand({
        ...interrupted,
        command: { envNames: [], intentAt: ago(MINUTE), exitCode: 0 },
      }),
    ).toBe(false);
    expect(
      isInterruptedCommand({
        ...interrupted,
        command: { envNames: [], intentAt: ago(MINUTE), signal: 'SIGTERM' },
      }),
    ).toBe(false);
    expect(isInterruptedCommand({ ...interrupted, command: undefined })).toBe(false);
  });
});

describe('endedWhileRunning', () => {
  const publish = (changes: Partial<StepRun>) =>
    stepOf({
      id: 'publish',
      kind: 'run',
      status: 'failed',
      command: { envNames: [], intentAt: ago(MINUTE), exitCode: 1 },
      ...changes,
    });

  it('says how a failed command was ended while it ran: stopped, timed out, or killed', () => {
    const stopped = { envNames: [], intentAt: ago(MINUTE), signal: 'SIGTERM' };
    expect(
      endedWhileRunning(
        publish({ error: 'Stopped while running: it may have done its work', command: stopped }),
      ),
    ).toBe('stopped');
    // A shell that traps the signal exits with a code: the error still says it was stopped.
    expect(
      endedWhileRunning(publish({ error: 'Stopped while running: it may have done its work' })),
    ).toBe('stopped');
    expect(endedWhileRunning(publish({ error: 'timed out after 10m', command: stopped }))).toBe(
      'timed-out',
    );
    expect(endedWhileRunning(publish({ error: 'timed out after 30s' }))).toBe('timed-out');
    expect(
      endedWhileRunning(
        publish({
          error: 'killed by SIGKILL',
          command: { envNames: [], intentAt: ago(MINUTE), signal: 'SIGKILL' },
        }),
      ),
    ).toBe('killed');
  });

  it('is null for a command that exited on its own, one with no result, an agent step, or another status', () => {
    expect(endedWhileRunning(publish({ error: 'exit 1: HTTP 502: Bad Gateway' }))).toBeNull();
    // Interrupted by a quit: no result at all. That is isInterruptedCommand's.
    expect(
      endedWhileRunning(
        publish({ error: 'Interrupted', command: { envNames: [], intentAt: ago(MINUTE) } }),
      ),
    ).toBeNull();
    expect(
      endedWhileRunning(
        publish({ kind: 'agent', error: 'Stopped while running: it may have done its work' }),
      ),
    ).toBeNull();
    expect(
      endedWhileRunning(publish({ status: 'completed', error: 'timed out after 10m' })),
    ).toBeNull();
  });
});

describe('retryWarningOf', () => {
  const publish = (changes: Partial<StepRun>) =>
    stepOf({ id: 'publish', kind: 'run', status: 'failed', ...changes });
  const PR = { type: 'pr' as const };

  it('warns before retrying a command Consola quit on, word for word', () => {
    const interrupted = publish({ command: { envNames: [], intentAt: ago(MINUTE) } });
    expect(retryWarningOf(interrupted, PR)).toBe(
      'Consola quit while this command ran; check the pull request first — it may already be posted.',
    );
  });

  it('warns before retrying a command ended while it ran, saying how, and what to check', () => {
    const ran = { envNames: [], intentAt: ago(MINUTE), signal: 'SIGTERM' };
    expect(
      retryWarningOf(
        publish({ error: 'Stopped while running: it may have done its work', command: ran }),
        PR,
      ),
    ).toBe('It was stopped while it ran and may have done its work; check the pull request first.');
    expect(retryWarningOf(publish({ error: 'timed out after 10m', command: ran }), PR)).toBe(
      'It timed out while it ran and may have done its work; check the pull request first.',
    );
    expect(
      retryWarningOf(
        publish({ error: 'killed by SIGKILL', command: { ...ran, signal: 'SIGKILL' } }),
        { type: 'issue' },
      ),
    ).toBe('It was killed while it ran and may have done its work; check the issue first.');
    // A schedule's run has no item to check.
    expect(retryWarningOf(publish({ error: 'timed out after 10m', command: ran }), undefined)).toBe(
      'It timed out while it ran and may have done its work; check what it did first.',
    );
  });

  it('is null for a step that ended on its own', () => {
    expect(
      retryWarningOf(
        publish({
          error: 'exit 1: HTTP 502',
          command: { envNames: [], intentAt: ago(MINUTE), exitCode: 1 },
        }),
        PR,
      ),
    ).toBeNull();
    expect(
      retryWarningOf(
        stepOf({ id: 'review', status: 'failed', error: 'It stopped before finishing (exit 1).' }),
        PR,
      ),
    ).toBeNull();
  });
});

describe('runStages for a steps run', () => {
  it('an asked and approved run has trigger, approval, then a node per step', () => {
    const run = stepsRecord(
      [
        stepOf({
          id: 'fetch',
          kind: 'run',
          status: 'completed',
          queuedAt: ago(8 * MINUTE),
          startedAt: ago(8 * MINUTE),
          finishedAt: ago(7 * MINUTE),
        }),
        stepOf({
          id: 'review',
          status: 'completed',
          queuedAt: ago(7 * MINUTE),
          startedAt: ago(6 * MINUTE),
          finishedAt: ago(4 * MINUTE),
        }),
      ],
      {
        mode: 'confirm',
        approvedAt: ago(9 * MINUTE),
        startedAt: ago(8 * MINUTE),
        finishedAt: ago(4 * MINUTE),
      },
    );
    expect(stepShape(run)).toEqual([
      'trigger:passed',
      'approval:passed',
      'step:fetch:passed',
      'step:review:passed',
    ]);
    expect(msOf(run, 'approval')).toBe(MINUTE);
    expect(stepMs(run, 'fetch')).toBe(MINUTE);
    // From queuedAt, so the wait for a slot counts.
    expect(stepMs(run, 'review')).toBe(3 * MINUTE);
  });

  it('carries the step on its stage', () => {
    const run = stepsRecord(
      [stepOf({ id: 'fetch', kind: 'run', status: 'failed', attempt: 2, error: 'boom' })],
      { status: 'failed' },
    );
    expect(runStages(run, NOW)[1].step).toEqual({
      id: 'fetch',
      kind: 'run',
      status: 'failed',
      error: 'boom',
      attempt: 2,
    });
  });

  it('a run at step 2 with step 3 pending counts the running step to now', () => {
    const run = stepsRecord(
      [
        stepOf({
          id: 'a',
          kind: 'run',
          status: 'completed',
          startedAt: ago(5 * MINUTE),
          finishedAt: ago(4 * MINUTE),
        }),
        stepOf({
          id: 'b',
          status: 'running',
          queuedAt: ago(4 * MINUTE),
          startedAt: ago(3 * MINUTE),
        }),
        stepOf({ id: 'c', status: 'pending' }),
      ],
      { status: 'running', startedAt: ago(5 * MINUTE) },
    );
    expect(stepShape(run)).toEqual([
      'trigger:passed',
      'step:a:passed',
      'step:b:running',
      'step:c:pending',
    ]);
    expect([stepMs(run, 'a'), stepMs(run, 'b'), stepMs(run, 'c')]).toEqual([
      MINUTE,
      4 * MINUTE,
      null,
    ]);
  });

  it('a queued step is queued, counting its wait', () => {
    const run = stepsRecord([stepOf({ id: 'a', status: 'queued', queuedAt: ago(30 * SECOND) })], {
      status: 'running',
    });
    expect(stepShape(run)).toEqual(['trigger:passed', 'step:a:queued']);
    expect(stepMs(run, 'a')).toBe(30 * SECOND);
  });

  it('a completed run with a skipped step keeps it skipped', () => {
    const run = stepsRecord(
      [
        stepOf({
          id: 'a',
          status: 'completed',
          startedAt: ago(2 * MINUTE),
          finishedAt: ago(MINUTE),
        }),
        stepOf({ id: 'b', status: 'skipped', skipped: 'if: false' }),
      ],
      { finishedAt: ago(MINUTE) },
    );
    expect(stepShape(run)).toEqual(['trigger:passed', 'step:a:passed', 'step:b:skipped']);
    expect(stepMs(run, 'b')).toBeNull();
  });

  it('a run that failed at review leaves publish skipped, and a pending step of an ended run is skipped too', () => {
    const run = stepsRecord(
      [
        stepOf({
          id: 'review',
          status: 'failed',
          startedAt: ago(2 * MINUTE),
          finishedAt: ago(MINUTE),
          error: 'no',
        }),
        stepOf({ id: 'publish', kind: 'run', status: 'not-run' }),
        stepOf({ id: 'tidy', kind: 'run', status: 'pending' }),
      ],
      { status: 'failed', finishedAt: ago(MINUTE) },
    );
    expect(stepShape(run)).toEqual([
      'trigger:passed',
      'step:review:failed',
      'step:publish:skipped',
      'step:tidy:skipped',
    ]);
    expect(stepMs(run, 'review')).toBe(MINUTE);
  });

  it('a dry run draws a reported step as reported', () => {
    const run = stepsRecord(
      [
        stepOf({
          id: 'review',
          status: 'completed',
          startedAt: ago(2 * MINUTE),
          finishedAt: ago(MINUTE),
        }),
        stepOf({ id: 'publish', kind: 'run', status: 'reported' }),
      ],
      { mode: 'notify', finishedAt: ago(MINUTE) },
    );
    expect(stepShape(run)).toEqual([
      'trigger:passed',
      'step:review:passed',
      'step:publish:reported',
    ]);
  });

  it('a run waiting for approval stands at approval with its steps pending', () => {
    const run = stepsRecord([stepOf({ id: 'a', status: 'pending' })], {
      mode: 'confirm',
      status: 'needs-approval',
    });
    expect(stepShape(run)).toEqual(['trigger:passed', 'approval:waiting', 'step:a:pending']);
    expect(msOf(run, 'approval')).toBe(10 * MINUTE);
  });

  it('a dismissed run stopped at approval', () => {
    const run = stepsRecord([stepOf({ id: 'a', status: 'pending' })], {
      mode: 'confirm',
      status: 'rejected',
      finishedAt: ago(8 * MINUTE),
    });
    expect(stepShape(run)).toEqual(['trigger:passed', 'approval:stopped', 'step:a:skipped']);
    expect(msOf(run, 'approval')).toBe(2 * MINUTE);
  });

  it('a waiting run stops at its waiting step', () => {
    const run = stepsRecord(
      [
        stepOf({ id: 'fresh', kind: 'run', status: 'completed' }),
        stepOf({ id: 'review', status: 'completed' }),
        stepOf({ id: 'decide', kind: 'gate', status: 'waiting', gate: { askedAt: ago(MINUTE) } }),
        stepOf({ id: 'publish', kind: 'run', status: 'pending' }),
      ],
      { status: 'waiting', startedAt: ago(5 * MINUTE) },
    );
    expect(runStages(run, NOW).find((stage) => stage.state === 'waiting')?.step?.id).toBe('decide');
    expect(stepShape(run)).toEqual([
      'trigger:passed',
      'step:fresh:passed',
      'step:review:passed',
      'step:decide:waiting',
      'step:publish:pending',
    ]);
  });
});

describe('retryTargetOf', () => {
  it('is the failed step', () => {
    const steps = [
      stepOf({ id: 'a', status: 'completed' }),
      stepOf({ id: 'b', status: 'failed' }),
      stepOf({ id: 'c', status: 'not-run' }),
    ];
    expect(retryTargetOf(steps)?.id).toBe('b');
  });

  it('is the first step not run when the run ended between steps', () => {
    const steps = [
      stepOf({ id: 'a', status: 'completed' }),
      stepOf({ id: 'b', status: 'not-run' }),
      stepOf({ id: 'c', status: 'not-run' }),
    ];
    expect(retryTargetOf(steps)?.id).toBe('b');
  });

  it('is the first step when none ran, and nothing when every step did', () => {
    expect(
      retryTargetOf([
        stepOf({ id: 'a', status: 'not-run' }),
        stepOf({ id: 'b', status: 'not-run' }),
      ])?.id,
    ).toBe('a');
    expect(retryTargetOf([stepOf({ id: 'a', status: 'completed' })])).toBeUndefined();
  });

  // Slice 3 (review B1): a failed leaf before its failed loop row, then a failed loop row, then the first not-run.
  it("is the failed step inside a loop, not the loop's row", () => {
    const steps = [
      stepOf({ id: 'fix', status: 'completed' }),
      stepOf({ id: 'polish', kind: 'repeat', status: 'failed', round: 2, max: 3 }),
      stepOf({ id: 'review', status: 'completed', round: 2, attempt: 2 }),
      stepOf({ id: 'address', status: 'failed', round: 2, attempt: 2, error: 'x' }),
      stepOf({ id: 'pr', kind: 'run', status: 'not-run' }),
    ];
    expect(retryTargetOf(steps)?.id).toBe('address');
  });

  it('is an exhausted loop, whose steps all completed', () => {
    const steps = [
      stepOf({ id: 'fix', status: 'completed' }),
      stepOf({
        id: 'polish',
        kind: 'repeat',
        status: 'failed',
        round: 3,
        max: 3,
        error: 'polish: not clean after 3 rounds',
      }),
      stepOf({ id: 'review', status: 'completed', round: 3, attempt: 3 }),
      stepOf({ id: 'address', status: 'completed', round: 3, attempt: 3 }),
      stepOf({ id: 'pr', kind: 'run', status: 'not-run' }),
    ];
    expect(retryTargetOf(steps)?.id).toBe('polish');
  });

  it('is the first step not run when a run with a loop ended between steps', () => {
    const steps = [
      stepOf({ id: 'fix', status: 'completed' }),
      stepOf({ id: 'polish', kind: 'repeat', status: 'completed', round: 1, max: 3 }),
      stepOf({ id: 'review', status: 'completed', round: 1 }),
      stepOf({ id: 'pr', kind: 'run', status: 'not-run' }),
    ];
    expect(retryTargetOf(steps)?.id).toBe('pr');
  });
});

describe('runRetryTarget', () => {
  const failedAtReview = [
    stepOf({ id: 'review', status: 'failed' }),
    stepOf({ id: 'publish', kind: 'run', status: 'not-run' }),
  ];
  const notRun = [
    stepOf({ id: 'review', status: 'not-run' }),
    stepOf({ id: 'publish', kind: 'run', status: 'not-run' }),
  ];

  it('is the step a failed run that started retries from', () => {
    expect(
      runRetryTarget(stepsRecord(failedAtReview, { status: 'failed', startedAt: ago(2 * MINUTE) }))
        ?.id,
    ).toBe('review');
    // Its checkout could not be prepared: it started, so it retries from its first step.
    expect(
      runRetryTarget(stepsRecord(notRun, { status: 'failed', startedAt: ago(2 * MINUTE) }))?.id,
    ).toBe('review');
  });

  it('is nothing for a run that never started: refused at approval, or turned away in line', () => {
    expect(
      runRetryTarget(
        stepsRecord(notRun, {
          status: 'failed',
          mode: 'confirm',
          error: 'Not run: factory.yml changed since this preview; run it again.',
        }),
      ),
    ).toBeUndefined();
  });

  it('is nothing for a run that did not fail', () => {
    expect(
      runRetryTarget(
        stepsRecord(failedAtReview, { status: 'rejected', startedAt: ago(2 * MINUTE) }),
      ),
    ).toBeUndefined();
    expect(
      runRetryTarget(
        stepsRecord(failedAtReview, { status: 'running', startedAt: ago(2 * MINUTE) }),
      ),
    ).toBeUndefined();
  });
});

describe('a step status this build does not know', () => {
  it('is pending while the run is open and skipped once it ended', () => {
    const odd = stepOf({ id: 'a', status: 'paused' as StepRun['status'] });
    expect(stepShape(stepsRecord([odd], { status: 'running' }))).toEqual([
      'trigger:passed',
      'step:a:pending',
    ]);
    expect(stepShape(stepsRecord([odd], { status: 'failed', finishedAt: ago(MINUTE) }))).toEqual([
      'trigger:passed',
      'step:a:skipped',
    ]);
  });
});

describe('legacy runs keep their stages', () => {
  it('a run without steps has no step stages', () => {
    const stages = runStages(record(), NOW);
    expect(stages.map((stage) => stage.key)).toEqual(['trigger', 'run']);
    expect(stages.every((stage) => stage.step === undefined)).toBe(true);
  });
});

describe('triggerStageWords', () => {
  it("names a poll run's trigger a check, never Run now", () => {
    const poll = record({
      trigger: { kind: 'poll', at: ago(MINUTE), item: { key: 'k', url: '', title: 'T' } },
    });
    const words = triggerStageWords(poll, undefined, undefined);
    expect(words.kicker).toBe('Check');
    expect(words.title).toBe('Found by its check');
    expect(words.outcome).toMatch(/^Checked /);
  });

  it('keeps Run now for a run by a person', () => {
    const manual = record({ trigger: { kind: 'manual', at: ago(MINUTE), by: 'person' } });
    expect(triggerStageWords(manual, undefined, undefined).kicker).toBe('Run now');
  });
});

// Slice 3: gates, loops and waits on the run page.
describe('a run rejected at a gate', () => {
  const T1 = ago(5 * MINUTE);
  const T2 = ago(4 * MINUTE);
  const gate = (decision?: string) =>
    stepOf({
      id: 'decide',
      kind: 'gate',
      status: 'completed',
      gate: { askedAt: T1, ...(decision ? { decision, by: 'person' as const, at: T2 } : {}) },
    });
  const rejectedSteps = [
    stepOf({ id: 'fresh', kind: 'run', status: 'completed' }),
    stepOf({ id: 'review', status: 'completed' }),
    gate('reject'),
    stepOf({ id: 'publish-decided', kind: 'run', status: 'not-run' }),
  ];

  it('is not turned down, and says where', () => {
    const run = stepsRecord(rejectedSteps, {
      status: 'rejected',
      startedAt: ago(9 * MINUTE),
      finishedAt: T2,
    });
    expect(rejectedAtGate(run)).toBe('decide');
    expect(rejectedWords(run)).toBe('rejected at `decide` by you, after 2 steps');
    expect(runStages(run, NOW).find((stage) => stage.state === 'stopped')?.step?.id).toBe('decide');
    expect(stepShape(run)).toEqual([
      'trigger:passed',
      'step:fresh:passed',
      'step:review:passed',
      'step:decide:stopped',
      'step:publish-decided:skipped',
    ]);
  });

  it('counts one step as one, and only the agent and command steps that ran', () => {
    const run = stepsRecord(
      [
        stepOf({ id: 'fresh', kind: 'run', status: 'skipped' }),
        stepOf({ id: 'review', status: 'completed' }),
        // A gate went past is no step that ran.
        { ...gate('approve'), id: 'first-look' },
        gate('reject'),
      ],
      { status: 'rejected', startedAt: ago(9 * MINUTE) },
    );
    expect(rejectedWords(run)).toBe('rejected at `decide` by you, after 1 step');
  });

  it('a confirm run rejected at a gate passed its approval, even an older record with no approvedAt', () => {
    const run = stepsRecord(rejectedSteps, {
      status: 'rejected',
      mode: 'confirm',
      startedAt: ago(9 * MINUTE),
      finishedAt: T2,
    });
    expect(stepShape(run).slice(0, 2)).toEqual(['trigger:passed', 'approval:passed']);
  });

  it('a run rejected before it started is still turned down', () => {
    const run = stepsRecord(
      [stepOf({ id: 'review', status: 'not-run' }), stepOf({ id: 'publish', status: 'not-run' })],
      { status: 'rejected', mode: 'confirm', finishedAt: ago(MINUTE) },
    );
    expect(rejectedAtGate(run)).toBeUndefined();
    expect(rejectedWords(run)).toBeNull();
    expect(stepShape(run).slice(0, 2)).toEqual(['trigger:passed', 'approval:stopped']);
  });

  it('a gate answered with a choice is passed, not stopped', () => {
    const run = stepsRecord([gate('approve')], { status: 'completed', startedAt: ago(MINUTE) });
    expect(stepShape(run)).toEqual(['trigger:passed', 'step:decide:passed']);
    expect(rejectedWords(run)).toBeNull();
  });
});

describe("a loop's rows", () => {
  const preview = {
    kind: 'steps-run' as const,
    steps: [
      { id: 'fix', kind: 'run' as const },
      { id: 'polish', kind: 'repeat' as const },
      { id: 'review', kind: 'agent' as const, loop: 'polish' },
      { id: 'address', kind: 'agent' as const, loop: 'polish' },
      { id: 'pr', kind: 'run' as const },
    ],
  };
  const inRound2Run = stepsRecord(
    [
      stepOf({ id: 'fix', kind: 'run', status: 'completed' }),
      stepOf({ id: 'polish', kind: 'repeat', status: 'running', round: 2, max: 3 }),
      stepOf({
        id: 'review',
        status: 'running',
        round: 2,
        attempt: 2,
        previous: [{ attempt: 1, status: 'completed', round: 1 }],
      }),
      stepOf({ id: 'address', status: 'completed', round: 1, attempt: 1 }),
      stepOf({ id: 'pr', kind: 'run', status: 'pending' }),
    ],
    { status: 'running', startedAt: ago(5 * MINUTE) },
  );
  const byId = (steps: StepRun[], id: string) => steps.find((step) => step.id === id)!;
  const shapeOf = (rows: ReturnType<typeof traceRows>) =>
    rows.map((row) =>
      row.kind === 'loop'
        ? ['loop', row.row.id, row.inner.map((inner) => inner.id), row.round, row.max]
        : ['step', row.row.id],
    );

  it('names its steps from the preview', () => {
    expect(loopsOf(preview)).toEqual({ polish: ['review', 'address'] });
    expect(loopsOf({ steps: [{ id: 'a', kind: 'run' }] })).toEqual({});
  });

  it("groups a loop's rows under it, each with its rounds", () => {
    const rows = traceRows(inRound2Run, { polish: ['review', 'address'] });
    expect(shapeOf(rows)).toEqual([
      ['step', 'fix'],
      ['loop', 'polish', ['review', 'address'], 2, 3],
      ['step', 'pr'],
    ]);
    expect(roundsOf(byId(inRound2Run.steps!, 'review'))).toEqual([
      { round: 1, attempt: 1, status: 'completed' },
      { round: 2, attempt: 2, status: 'running' },
    ]);
    expect(roundsOf(byId(inRound2Run.steps!, 'fix'))).toEqual([]);
    // Oldest first, however the earlier lines were kept.
    expect(
      roundsOf(
        stepOf({
          id: 'review',
          status: 'running',
          round: 3,
          attempt: 3,
          previous: [
            { attempt: 2, status: 'completed', round: 2 },
            { attempt: 1, status: 'completed', round: 1 },
          ],
        }),
      ).map((one) => one.round),
    ).toEqual([1, 2, 3]);
  });

  it('before round 1 its steps carry no round: the preview still names them', () => {
    const before = stepsRecord(
      [
        stepOf({ id: 'polish', kind: 'repeat', status: 'pending' }),
        stepOf({ id: 'review', status: 'pending' }),
        stepOf({ id: 'address', status: 'pending' }),
        stepOf({ id: 'pr', kind: 'run', status: 'pending' }),
      ],
      { status: 'running' },
    );
    expect(shapeOf(traceRows(before, loopsOf(preview)))).toEqual([
      ['loop', 'polish', ['review', 'address'], undefined, undefined],
      ['step', 'pr'],
    ]);
    // An older record with no preview: the rows after it that carry a round.
    expect(shapeOf(traceRows(inRound2Run, {}))).toEqual([
      ['step', 'fix'],
      ['loop', 'polish', ['review', 'address'], 2, 3],
      ['step', 'pr'],
    ]);
  });

  it('offers Retry from the failed step inside a loop, as the engine retries it (review B1)', () => {
    const run = stepsRecord(
      [
        stepOf({ id: 'fix', kind: 'run', status: 'completed' }),
        stepOf({ id: 'polish', kind: 'repeat', status: 'failed', round: 2, max: 3 }),
        stepOf({ id: 'review', status: 'completed', round: 2, attempt: 2 }),
        stepOf({ id: 'address', status: 'failed', round: 2, attempt: 2, error: 'x' }),
        stepOf({ id: 'pr', kind: 'run', status: 'not-run' }),
      ],
      { status: 'failed', startedAt: ago(5 * MINUTE) },
    );
    expect(runRetryTarget(run)?.id).toBe('address');
  });
});

describe('Stop and the lead on a waiting run (review S1)', () => {
  it('offers Stop for a running or waiting run only', () => {
    expect((['running', 'waiting'] as const).map((status) => stopOffered({ status }))).toEqual([
      true,
      true,
    ]);
    expect(
      (['queued', 'needs-approval', 'completed', 'failed', 'rejected'] as const).some((status) =>
        stopOffered({ status }),
      ),
    ).toBe(false);
  });

  const clock = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const RETRY_AT = '2026-11-12T12:42:00.000Z';

  it("words a waiting run's lead: asked at a gate, retries at a time", () => {
    const atGate = stepsRecord(
      [
        stepOf({ id: 'review', status: 'completed' }),
        stepOf({
          id: 'decide',
          kind: 'gate',
          status: 'waiting',
          gate: { askedAt: ago(5 * MINUTE) },
        }),
      ],
      { status: 'waiting', startedAt: ago(9 * MINUTE), updatedAt: ago(5 * MINUTE) },
    );
    expect(leadDetail(atGate, NOW, undefined)).toBe('asked 5m ago');
    const retrying = stepsRecord(
      [stepOf({ id: 'look', status: 'waiting', retryAt: RETRY_AT, retries: 1 })],
      { status: 'waiting', startedAt: ago(9 * MINUTE) },
    );
    expect(leadDetail(retrying, NOW, undefined)).toBe(`retries at ${clock(RETRY_AT)}`);
    // The whole run's own wait: on the run, its rows as they were.
    const again = stepsRecord([stepOf({ id: 'look', status: 'failed' })], {
      status: 'waiting',
      startedAt: ago(9 * MINUTE),
      retryAt: RETRY_AT,
    });
    expect(leadDetail(again, NOW, undefined)).toBe(`retries at ${clock(RETRY_AT)}`);
  });

  it("leaves every other status's words as they were", () => {
    expect(
      leadDetail(record({ status: 'running', startedAt: ago(2 * MINUTE) }), NOW, undefined),
    ).toBe('for 2m 0s');
    expect(leadDetail(record({ status: 'queued', createdAt: ago(3 * MINUTE) }), NOW, 2)).toBe(
      '2 in line',
    );
    expect(
      leadDetail(record({ status: 'queued', createdAt: ago(3 * MINUTE) }), NOW, undefined),
    ).toBe('3m ago');
    expect(
      leadDetail(record({ status: 'needs-approval', createdAt: ago(7 * MINUTE) }), NOW, undefined),
    ).toBe('asked 7m ago');
    expect(
      leadDetail(
        record({
          status: 'failed',
          startedAt: ago(10 * MINUTE),
          finishedAt: ago(8 * MINUTE),
        }),
        NOW,
        undefined,
      ),
    ).toBe('after 2m 0s · 8m ago');
    expect(
      leadDetail(
        record({
          status: 'completed',
          startedAt: ago(10 * MINUTE),
          finishedAt: ago(9 * MINUTE),
        }),
        NOW,
        undefined,
      ),
    ).toBe('in 1m 0s · 9m ago');
  });
});
