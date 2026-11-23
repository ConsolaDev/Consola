import { describe, expect, it } from 'vitest';
import type { RunRecord, StepRun } from '../../../shared/automations';
import type { LogTail } from '../../../shared/automations';
import {
  agentFacts,
  artifactNote,
  attemptsLine,
  conditionValues,
  deniedLine,
  durationOf,
  earlierCosts,
  failureWords,
  failureIsExit,
  LOG_CAP_BYTES,
  logWasCapped,
  notRunReason,
  retryLine,
  retryScope,
  skippedCondition,
  stepCounts,
  stepOutcome,
  stepSummary,
  stepTone,
  turnFacts,
  turnLine,
  variableRows,
  visibleTail,
  writeRows,
  artifactTitle,
  diffMarkdown,
} from './stepDetail';

const NOW = new Date('2026-11-12T12:00:00.000Z');

function step(overrides: Partial<StepRun> = {}): StepRun {
  return { id: 'publish', kind: 'run', status: 'completed', attempt: 1, ...overrides };
}

describe('variableRows', () => {
  it('keeps each name, its template and its rendered value, in the file order', () => {
    const rows = variableRows({
      cwd: '/work',
      command: 'gh pr review "$PR"',
      env: [
        { name: 'PR', template: '{{ item.number }}', value: '51' },
        { name: 'REPO', template: 'sprocket/catalog-portal', value: 'sprocket/catalog-portal' },
      ],
    });
    expect(rows).toEqual([
      { name: 'PR', template: '{{ item.number }}', value: '51', long: false, templated: true },
      {
        name: 'REPO',
        template: 'sprocket/catalog-portal',
        value: 'sprocket/catalog-portal',
        long: false,
        templated: false,
      },
    ]);
  });

  it('reads a path inline, and folds a value past 300 characters or with a newline', () => {
    const env = (value: string) => ({
      cwd: '/',
      command: 'x',
      env: [{ name: 'V', template: '{{ x }}', value }],
    });
    expect(variableRows(env('a'.repeat(300)))[0].long).toBe(false);
    expect(variableRows(env('a'.repeat(301)))[0].long).toBe(true);
    expect(variableRows(env('one\ntwo'))[0].long).toBe(true);
  });
});

describe('attemptsLine', () => {
  it('is null for a first attempt that was not reminded', () => {
    expect(attemptsLine(step())).toBeNull();
  });
  it('counts earlier failures', () => {
    expect(attemptsLine(step({ attempt: 2, previous: [{ attempt: 1, status: 'failed' }] }))).toBe(
      'Attempt 2 · earlier: 1 failed',
    );
  });
  it('words an attempt that did not run as did not run, never failed', () => {
    expect(attemptsLine(step({ attempt: 2, previous: [{ attempt: 1, status: 'not-run' }] }))).toBe(
      'Attempt 2 · earlier: 1 did not run',
    );
  });
  it('lists attempts by number, not grouped by wording, even when not contiguous', () => {
    expect(
      attemptsLine(
        step({
          attempt: 4,
          previous: [
            { attempt: 3, status: 'failed' },
            { attempt: 1, status: 'failed' },
            { attempt: 2, status: 'not-run' },
          ],
        }),
      ),
    ).toBe('Attempt 4 · earlier: 1 failed, 2 did not run, 3 failed');
  });
  it('lists several earlier attempts in attempt order', () => {
    expect(
      attemptsLine(
        step({
          attempt: 4,
          previous: [
            { attempt: 1, status: 'failed' },
            { attempt: 2, status: 'not-run' },
            { attempt: 3, status: 'not-run' },
          ],
        }),
      ),
    ).toBe('Attempt 4 · earlier: 1 failed, 2 did not run, 3 did not run');
  });
  it('adds reminded once', () => {
    expect(
      attemptsLine(
        step({ attempt: 2, reminded: true, previous: [{ attempt: 1, status: 'failed' }] }),
      ),
    ).toBe('Attempt 2 · earlier: 1 failed · reminded once');
    expect(attemptsLine(step({ reminded: true }))).toBe('Reminded once');
  });
});

describe('durationOf', () => {
  it('is the span between start and finish', () => {
    expect(
      durationOf(
        step({ startedAt: '2026-11-12T11:00:00.000Z', finishedAt: '2026-11-12T11:00:05.000Z' }),
        NOW,
      ),
    ).toBe(5000);
  });
  it('runs to now while the step runs', () => {
    expect(
      durationOf(step({ status: 'running', startedAt: '2026-11-12T11:59:00.000Z' }), NOW),
    ).toBe(60000);
  });
  it('is null for a step that never started, or has no end', () => {
    expect(durationOf(step({ status: 'queued' }), NOW)).toBeNull();
    expect(
      durationOf(step({ status: 'failed', startedAt: '2026-11-12T11:59:00.000Z' }), NOW),
    ).toBeNull();
  });
  it('never goes below zero', () => {
    expect(
      durationOf(
        step({ startedAt: '2026-11-12T11:00:05.000Z', finishedAt: '2026-11-12T11:00:00.000Z' }),
        NOW,
      ),
    ).toBe(0);
  });
  it('is null for an unparseable timestamp', () => {
    expect(
      durationOf(step({ startedAt: 'soon', finishedAt: '2026-11-12T11:00:00.000Z' }), NOW),
    ).toBeNull();
    expect(
      durationOf(step({ startedAt: '2026-11-12T11:00:00.000Z', finishedAt: 'later' }), NOW),
    ).toBeNull();
  });
});

describe('logWasCapped', () => {
  const over = LOG_CAP_BYTES + 1;
  it('decides per stream from its own byte count', () => {
    expect(logWasCapped(over)).toBe(true); // stdout capped...
    expect(logWasCapped(10)).toBe(false); // ...stderr not
    expect(logWasCapped(10)).toBe(false); // the reverse: stdout not
    expect(logWasCapped(over)).toBe(true); // stderr capped
    expect(logWasCapped(LOG_CAP_BYTES)).toBe(false);
    expect(logWasCapped(undefined)).toBe(false);
  });
});

describe('visibleTail', () => {
  const tail = (bytes: number, text = 't'): LogTail => ({ text, bytes, truncated: bytes > 10 });
  it('keeps what Show all read while the file is the size it was read at, across a refetch', () => {
    const full = tail(100, 'everything');
    expect(visibleTail(tail(100, 'end'), full)).toBe(full);
  });
  it('drops it once the file has grown', () => {
    const fresh = tail(200, 'end');
    expect(visibleTail(fresh, tail(100, 'everything'))).toBe(fresh);
  });
  it('shows the latest tail when Show all was never used', () => {
    const initial = tail(100);
    expect(visibleTail(initial, undefined)).toBe(initial);
  });
});

function run(
  overrides: Partial<Pick<RunRecord, 'status' | 'steps'>> = {},
): Pick<RunRecord, 'status' | 'steps'> {
  return { status: 'completed', steps: [], ...overrides };
}

describe('stepTone and stepOutcome', () => {
  it('reads each status as the trace marks it', () => {
    expect(stepTone('completed', true)).toBe('passed');
    expect(stepTone('failed', true)).toBe('failed');
    expect(stepTone('running', false)).toBe('running');
    expect(stepTone('queued', false)).toBe('waiting');
    expect(stepTone('skipped', true)).toBe('skipped');
    expect(stepTone('reported', true)).toBe('reported');
    expect(stepTone('not-run', true)).toBe('not-run');
  });
  it('reads a pending step as still to come in a run that is open, and as not run once it is over', () => {
    expect(stepTone('pending', false)).toBe('pending');
    expect(stepTone('pending', true)).toBe('not-run');
    // Statuses only grow: one this build does not know is never drawn as an outcome.
    expect(stepTone('paused' as StepRun['status'], true)).toBe('not-run');
  });
  it('says how it went, with how long where it ran', () => {
    expect(stepOutcome('passed', 3000)).toBe('Completed in 3s');
    expect(stepOutcome('failed', 400)).toBe('Failed after <1s');
    expect(stepOutcome('running', 61_000)).toBe('Running · 1m 1s');
    expect(stepOutcome('passed', null)).toBe('Completed');
    expect(stepOutcome('skipped', null)).toBe('Skipped');
    expect(stepOutcome('not-run', null)).toBe('Did not run');
    expect(stepOutcome('reported', null)).toBe('Would have run');
    expect(stepOutcome('waiting', null)).toBe('Waiting for a slot');
  });
});

describe('skippedCondition and conditionValues', () => {
  it('reads the if: back out of a false-condition skip, and nothing else', () => {
    expect(skippedCondition("if: steps.triage.focus == 'fixes' is false")).toBe(
      "steps.triage.focus == 'fixes'",
    );
    expect(skippedCondition('steps.fresh.needed has no value: fresh did not complete')).toBeNull();
    expect(skippedCondition(undefined)).toBeNull();
  });
  it('finds each output a condition read, once, with the value the run recorded', () => {
    const steps = [
      step({ id: 'triage', kind: 'agent', outputs: { focus: 'chores' } }),
      step({ id: 'size', outputs: { files: 6, empty: false } }),
    ];
    expect(
      conditionValues("steps.triage.focus == 'fixes' || steps.triage.focus == 'features'", steps),
    ).toEqual([{ ref: 'steps.triage.focus', step: 'triage', value: 'chores' }]);
    expect(conditionValues('steps.size.empty && steps.size.files > 3', steps)).toEqual([
      { ref: 'steps.size.empty', step: 'size', value: false },
      { ref: 'steps.size.files', step: 'size', value: 6 },
    ]);
    expect(conditionValues('steps.gone.flag', steps)).toEqual([
      { ref: 'steps.gone.flag', step: 'gone', value: undefined },
    ]);
  });
});

describe('notRunReason', () => {
  it('names the step the run stopped at', () => {
    const steps = [
      step({ id: 'first' }),
      step({ id: 'flaky', status: 'failed' }),
      step({ id: 'slow', status: 'not-run' }),
    ];
    expect(notRunReason(run({ status: 'failed', steps }))).toBe(
      'The run stopped at flaky before reaching it.',
    );
  });
  it('says a run was turned down, failed between steps, or ended', () => {
    expect(notRunReason(run({ status: 'rejected' }))).toBe(
      'The run was turned down before it started.',
    );
    expect(notRunReason(run({ status: 'failed', steps: [step({ status: 'not-run' })] }))).toBe(
      'The run failed before reaching it.',
    );
    expect(notRunReason(run({ status: 'completed' }))).toBe('The run ended before reaching it.');
  });
});

describe('stepSummary', () => {
  it('says what a step left behind: its outputs, its artifacts, else what it printed', () => {
    expect(stepSummary(step({ id: 'size', outputs: { files: 6 } }), run())).toBe('Set files = 6');
    expect(
      stepSummary(
        step({
          id: 'triage',
          kind: 'agent',
          outputs: { focus: 'chores' },
          artifacts: [{ name: 'handover', bytes: 2082 }],
        }),
        run(),
      ),
    ).toBe('Set focus = chores · wrote its handover (2.0 KB)');
    expect(
      stepSummary(step({ id: 'log', artifacts: [{ name: 'output', bytes: 2365 }] }), run()),
    ).toBe('Kept its stdout as output (2.3 KB)');
    expect(
      stepSummary(
        step({ command: { envNames: [], exitCode: 0, stdoutBytes: 17, stderrBytes: 0 } }),
        run(),
      ),
    ).toBe('Printed 17 B');
    expect(
      stepSummary(
        step({ command: { envNames: [], exitCode: 0, stdoutBytes: 0, stderrBytes: 12 } }),
        run(),
      ),
    ).toBe('12 B on stderr');
    expect(
      stepSummary(
        step({ command: { envNames: [], exitCode: 0, stdoutBytes: 0, stderrBytes: 0 } }),
        run(),
      ),
    ).toBe('Printed nothing');
  });
  it('cuts a long output value short, on one line', () => {
    const summary = stepSummary(step({ outputs: { note: `${'word '.repeat(20)}\nmore` } }), run());
    expect(summary).toBe(`Set note = ${'word '.repeat(7)}word…`);
  });
  it('gives a failure word for word', () => {
    expect(
      stepSummary(
        step({ status: 'failed', error: 'exit 3: touch ~/.ok first' }),
        run({ status: 'failed' }),
      ),
    ).toBe('exit 3: touch ~/.ok first');
    expect(stepSummary(step({ status: 'failed' }), run({ status: 'failed' }))).toBe(
      'It failed without saying why.',
    );
  });
  it('says why a step did not run', () => {
    expect(
      stepSummary(step({ status: 'skipped', skipped: 'if: steps.fresh.needed is false' }), run()),
    ).toBe('if: steps.fresh.needed was false');
    expect(
      stepSummary(step({ status: 'skipped', skipped: 'steps.fresh.needed has no value' }), run()),
    ).toBe('steps.fresh.needed has no value');
    const steps = [
      step({ id: 'review', status: 'failed' }),
      step({ id: 'publish', status: 'not-run' }),
    ];
    expect(stepSummary(steps[1], run({ status: 'failed', steps }))).toBe(
      'The run stopped at review before reaching it.',
    );
    expect(stepSummary(step({ status: 'reported' }), run())).toBe('A dry run: it was not run');
  });
  it('leaves a step still to come, or a working command, to its outcome', () => {
    expect(stepSummary(step({ status: 'pending' }), run({ status: 'running' }))).toBeNull();
    expect(stepSummary(step({ status: 'running' }), run({ status: 'running' }))).toBeNull();
    expect(
      stepSummary(step({ status: 'running', kind: 'agent' }), run({ status: 'running' })),
    ).toBe('Working in a read-only session');
  });
});

describe('failureWords', () => {
  it('reads an exit code and the last stderr line out of a command failure', () => {
    expect(failureWords('exit 3: touch ~/.ok first')).toEqual({
      text: 'Its command exited with code 3. The last line it wrote to stderr:',
      quote: 'touch ~/.ok first',
    });
    expect(failureWords('exit 1')).toEqual({
      text: 'Its command exited with code 1.',
      quote: null,
    });
    expect(failureWords('killed by SIGKILL')).toEqual({
      text: 'Its command was killed by SIGKILL.',
      quote: null,
    });
    expect(failureWords('timed out after 20s')).toEqual({
      text: 'Its command ran past its 20s timeout and was stopped.',
      quote: null,
    });
  });
  it('gives any other error as a sentence', () => {
    expect(failureWords('ended without setting verdict')).toEqual({
      text: 'Ended without setting verdict.',
      quote: null,
    });
    expect(failureWords('Stopped while running: it may have done its work')).toEqual({
      text: 'Stopped while running: it may have done its work.',
      quote: null,
    });
    expect(failureWords(undefined)).toEqual({ text: 'It failed without saying why.', quote: null });
  });
});

describe('retryScope', () => {
  const steps = [
    step({ id: 'first' }),
    step({ id: 'second' }),
    step({ id: 'flaky', status: 'failed' }),
    step({ id: 'slow', status: 'not-run' }),
    step({ id: 'last', status: 'not-run' }),
  ];
  it('names what a retry runs again after its step, and what keeps what it did', () => {
    expect(retryScope(steps, 'flaky')).toEqual({
      later: ['slow', 'last'],
      earlier: ['first', 'second'],
    });
    expect(retryScope([step({ id: 'only', status: 'failed' })], 'only')).toEqual({
      later: [],
      earlier: [],
    });
    expect(retryScope(steps, 'missing')).toBeNull();
  });
});

describe('failureIsExit', () => {
  it('is true only for an exit code or a signal, with or without the last stderr line', () => {
    expect(failureIsExit('exit 3: touch ~/.ok first')).toBe(true);
    expect(failureIsExit('exit 1')).toBe(true);
    expect(failureIsExit('killed by SIGTERM')).toBe(true);
    expect(failureIsExit('timed out after 20s')).toBe(false);
    expect(failureIsExit('ended without setting verdict')).toBe(false);
    expect(failureIsExit(undefined)).toBe(false);
  });
});

describe('artifactNote and stepCounts', () => {
  it('says what the two artifacts every step may write are for', () => {
    expect(artifactNote('handover', 'agent')).toBe('what it handed to the steps after it');
    expect(artifactNote('output', 'run')).toBe('its stdout, kept for the steps after it');
    expect(artifactNote('report', 'agent')).toBeNull();
  });
  it('counts how the steps went', () => {
    const steps = [
      step(),
      step(),
      step({ status: 'skipped' }),
      step({ status: 'failed' }),
      step({ status: 'pending' }),
    ];
    expect(stepCounts(steps, true)).toBe(
      '5 steps · 2 completed · 1 failed · 1 skipped · 1 did not run',
    );
    expect(stepCounts([step({ status: 'running' }), step({ status: 'pending' })], false)).toBe(
      '2 steps · 1 running · 1 to come',
    );
  });
});

describe('what a step’s turns report', () => {
  const agentStep = (fields: Partial<StepRun> = {}): StepRun => ({
    id: 'look',
    kind: 'agent',
    status: 'completed',
    attempt: 1,
    ...fields,
  });

  it.each<[Partial<StepRun>, string | null]>([
    [{ turn: { turns: 7, costUsd: 0.0412 } }, '7 turns · $0.0412 est.'],
    [{ turn: { turns: 1, costUsd: 0.0412 } }, '1 turn · $0.0412 est.'],
    [{ turn: { turns: 7 } }, '7 turns'],
    [{ turn: { costUsd: 0.0412 } }, '$0.0412 est.'],
    [{ turn: { costUsd: 0 } }, '$0.0000 est.'],
    [{ turn: { maxTurns: 30 } }, null],
    [{ model: 'claude-opus-5-5' }, null],
    [{}, null],
  ])('turnFacts(%j)', (fields, expected) => {
    expect(turnFacts(agentStep(fields))).toBe(expected);
  });

  it('a command has no turn facts', () => {
    expect(turnFacts({ ...agentStep({ turn: { turns: 3 } }), kind: 'run' })).toBeNull();
  });

  it.each<[Partial<StepRun>, string | null]>([
    [
      { turn: { turns: 7, costUsd: 0.0412, maxTurns: 30 }, model: 'claude-opus-5-5' },
      '7 turns of at most 30 · $0.0412 est. · claude-opus-5-5',
    ],
    [
      { turn: { turns: 7, costUsd: 0.0412 }, model: 'claude-opus-5-5' },
      '7 turns · $0.0412 est. · claude-opus-5-5',
    ],
    [{ turn: { turns: 1, maxTurns: 6 } }, '1 turn of at most 6'],
    [{ turn: { costUsd: 1.5, maxTurns: 6 } }, 'At most 6 turns · $1.50 est.'],
    // After a reminder the turns are both turns', and the step's cap held only the first.
    [
      {
        turn: { turns: 8, costUsd: 0.0412, maxTurns: 6 },
        reminded: true,
        model: 'claude-opus-5-5',
      },
      '8 turns · $0.0412 est. · claude-opus-5-5',
    ],
    [{ turn: { costUsd: 1.5, maxTurns: 6 }, reminded: true }, '$1.50 est.'],
    [{ model: 'claude-opus-5-5' }, 'claude-opus-5-5'],
    [{}, null],
  ])('turnLine(%j)', (fields, expected) => {
    expect(turnLine(agentStep(fields))).toBe(expected);
  });

  it('a command has no turn line', () => {
    expect(turnLine({ ...agentStep({ turn: { turns: 3 }, model: 'm' }), kind: 'run' })).toBeNull();
  });

  it('names each earlier attempt’s cost and turns, in attempt order, and says which reported none', () => {
    expect(
      earlierCosts(
        agentStep({
          attempt: 4,
          previous: [
            { attempt: 2, status: 'not-run' },
            { attempt: 1, status: 'failed', costUsd: 0.01, turns: 6 },
            { attempt: 3, status: 'failed', costUsd: 0.02, turns: 1 },
          ],
        }),
      ),
    ).toBe(
      'Earlier attempts: 1 $0.0100 est. in 6 turns, 2 no cost reported, 3 $0.0200 est. in 1 turn',
    );
    expect(
      earlierCosts(agentStep({ previous: [{ attempt: 1, status: 'failed', turns: 3 }] })),
    ).toBe('Earlier attempts: 1 no cost reported in 3 turns');
  });

  it('is null when no earlier attempt reported a cost or turns', () => {
    expect(earlierCosts(agentStep())).toBeNull();
    expect(earlierCosts(agentStep({ previous: [{ attempt: 1, status: 'failed' }] }))).toBeNull();
  });

  it('names the tools a turn was refused, once each, as recorded', () => {
    expect(deniedLine(agentStep({ turn: { deniedTools: ['mcp__a__b', 'Read'] } }))).toBe(
      'Denied: mcp__a__b, Read',
    );
    expect(deniedLine(agentStep({ turn: { deniedTools: [] } }))).toBeNull();
    expect(deniedLine(agentStep({ turn: { turns: 3 } }))).toBeNull();
    expect(deniedLine(agentStep())).toBeNull();
  });
});

describe('agentFacts (2-C)', () => {
  const agent = (fields: {
    mcpServers?: Array<{ name: string; tools?: string[] }>;
    skills?: string[];
  }) => ({
    agent: {
      name: 'investigator',
      hash: 'a'.repeat(64),
      body: 'B',
      mcpServers: fields.mcpServers ?? [],
      skills: fields.skills ?? [],
    },
  });

  it("gives an agent's servers, each narrowing, and its skills", () => {
    expect(
      agentFacts(
        agent({
          mcpServers: [{ name: 'claude.ai Coralogix' }, { name: 'grafana', tools: ['query_logs'] }],
          skills: ['incident-triage'],
        }),
      ),
    ).toEqual([
      { label: 'Servers', value: 'claude.ai Coralogix · grafana (query_logs)' },
      { label: 'Skills', value: 'incident-triage' },
    ]);
    expect(agentFacts(agent({ skills: ['incident-triage'] }))).toEqual([
      { label: 'Skills', value: 'incident-triage' },
    ]);
  });

  it('gives nothing for an agent naming neither, or no agent', () => {
    expect(agentFacts(agent({}))).toEqual([]);
    expect(agentFacts({})).toEqual([]);
  });
});

// Slice 3: a row parked at a gate or out a retry, a gate's answer, a loop's notes.
describe('gates, retries and loops in the trace', () => {
  const T1 = '2026-11-12T11:55:00.000Z';
  const gateRow = (status: StepRun['status'], gate?: StepRun['gate']) =>
    step({ id: 'decide', kind: 'gate', status, ...(gate ? { gate } : {}) });
  const clock = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  it('a waiting gate asks, a waiting retry waits to retry', () => {
    expect(stepTone(gateRow('waiting', { askedAt: T1 }), false)).toBe('asks');
    expect(
      stepTone(step({ id: 'look', kind: 'agent', status: 'waiting', retryAt: T1 }), false),
    ).toBe('retrying');
    // A loop's row at its exhaustion gate asks too.
    expect(
      stepTone(
        step({ id: 'polish', kind: 'repeat', status: 'waiting', gate: { askedAt: T1 } }),
        false,
      ),
    ).toBe('asks');
    expect(stepOutcome('asks', null)).toBe('Waiting for you');
    expect(stepOutcome('retrying', null)).toBe('Waiting to retry');
    // Only a status, as before: nothing to say it parked.
    expect(stepTone('waiting', false)).toBe('pending');
  });

  it('says where a parked row waits, and how a gate was answered', () => {
    const running = run({ status: 'waiting' });
    expect(stepSummary(gateRow('waiting', { askedAt: T1 }), running)).toBe(
      'waiting for you at decide',
    );
    expect(
      stepSummary(step({ id: 'look', kind: 'agent', status: 'waiting', retryAt: T1 }), running),
    ).toBe(`retries at ${clock(T1)}`);
    expect(
      stepSummary(
        gateRow('completed', { askedAt: T1, decision: 'comment', by: 'person', at: T1 }),
        run(),
        NOW,
      ),
    ).toBe('answered comment by you 5m ago');
    expect(
      stepSummary(
        step({ id: 'polish', kind: 'repeat', status: 'completed', note: 'clean after round 2' }),
        run(),
      ),
    ).toBe('clean after round 2');
    expect(stepSummary({ ...gateRow('reported'), note: 'Would have asked: Post it?' }, run())).toBe(
      'Would have asked: Post it?',
    );
  });

  it('draws a gate the person rejected as rejected, never as passed (3-A code review S2)', () => {
    const rejected = { askedAt: T1, decision: 'reject', by: 'person' as const, at: T1 };
    const gate = gateRow('completed', rejected);
    const ended = run({ status: 'rejected' });
    expect(stepTone(gate, true)).toBe('rejected');
    expect(stepOutcome('rejected', null)).toBe('Rejected');
    expect(stepSummary(gate, ended, NOW)).toBe('rejected by you 5m ago');
    // A loop rejected at its exhaustion gate: its row is completed with the decision, and no note.
    const loop = step({ id: 'polish', kind: 'repeat', status: 'completed', gate: rejected });
    expect(stepTone(loop, true)).toBe('rejected');
    expect(stepSummary(loop, ended, NOW)).toBe('rejected by you 5m ago');
    // An approved one still passes.
    expect(stepTone(gateRow('completed', { ...rejected, decision: 'approve' }), true)).toBe(
      'passed',
    );
    // Counted as rejected, not completed.
    const steps = [
      step({ id: 'look', kind: 'agent', status: 'completed' }),
      gate,
      step({ id: 'publish', status: 'not-run' }),
    ];
    expect(stepCounts(steps, true)).toBe('3 steps · 1 completed · 1 rejected · 1 did not run');
  });

  it("reads a not-run step's note, then a gate's rejection", () => {
    const thenStopped = run({
      status: 'completed',
      steps: [
        step({ id: 'not-ours', status: 'completed' }),
        step({ id: 'fix', status: 'not-run', note: 'the run stopped after `not-ours`' }),
      ],
    });
    expect(notRunReason(thenStopped, thenStopped.steps![1])).toBe(
      'the run stopped after `not-ours`',
    );
    expect(stepSummary(thenStopped.steps![1], thenStopped)).toBe(
      'the run stopped after `not-ours`',
    );
    const rejected = run({
      status: 'rejected',
      steps: [
        step({ id: 'review', kind: 'agent', status: 'completed' }),
        gateRow('completed', { askedAt: T1, decision: 'reject', by: 'person', at: T1 }),
        step({ id: 'publish-decided', status: 'not-run' }),
      ],
    });
    expect(notRunReason(rejected, rejected.steps![2])).toBe(
      'The run was rejected at `decide` before this step.',
    );
    // Turned down before it started: as before.
    expect(notRunReason(run({ status: 'rejected' }), step({ status: 'not-run' }))).toBe(
      'The run was turned down before it started.',
    );
    // Turned away after it started, at no gate (3-A code review M6): it did start.
    expect(
      notRunReason(
        { status: 'rejected', steps: [], startedAt: '2026-11-12T11:00:00.000Z' },
        step({ status: 'not-run' }),
      ),
    ).toBe('The run was turned away before reaching it.');
  });

  it('names the step a run failed at inside a loop, not the loop (review S10)', () => {
    const steps = [
      step({ id: 'polish', kind: 'repeat', status: 'failed', round: 2, max: 3 }),
      step({ id: 'review', kind: 'agent', status: 'completed', round: 2 }),
      step({ id: 'address', kind: 'agent', status: 'failed', round: 2 }),
      step({ id: 'pr', status: 'not-run' }),
    ];
    expect(notRunReason(run({ status: 'failed', steps }), steps[3])).toBe(
      'The run stopped at address before reaching it.',
    );
  });

  it("says when a step's retry runs, and which of its tries it will be", () => {
    const waiting = { retryAt: T1, retries: 1 };
    expect(retryLine(waiting, { onFailure: { retry: 2 } })).toBe(
      `retries at ${clock(T1)}, attempt 2 of 3`,
    );
    expect(retryLine(waiting)).toBe(`retries at ${clock(T1)}`);
    expect(retryLine({})).toBeNull();
  });

  it("counts a loop's steps, not its row, and words the parked ones", () => {
    const steps = [
      step({ id: 'polish', kind: 'repeat', status: 'running', round: 1, max: 3 }),
      step({ id: 'look', kind: 'agent', status: 'waiting', retryAt: T1 }),
      gateRow('waiting', { askedAt: T1 }),
    ];
    expect(stepCounts(steps, false)).toBe('2 steps · 1 waiting for you · 1 waiting to retry');
  });
});

describe("a write step's detail (slice 3-B Task 22)", () => {
  const FIX_STEP = step({
    id: 'fix',
    kind: 'agent',
    agent: 'ui-bugfixer',
    tools: 'write',
    environment: {
      name: 'sandboxed',
      isolation: 'sandbox',
      cliVersion: '2.1.330',
      passed: ['CI'],
      missing: [],
    },
    checkout: {
      before: 'b0b0b0b0b0b0',
      after: 'c1c1c1c1c1c1',
      files: 2,
      flagged: ['.github/workflows/ci.yml'],
    },
  });
  const FIX_ON_HOST = step({
    ...FIX_STEP,
    environment: { name: 'my-machine', isolation: 'host', passed: [], missing: ['CI'] },
  });

  it("a write step's detail says its environment, version, variables and commits", () =>
    expect(writeRows(FIX_STEP)).toEqual([
      ['Environment', 'sandboxed · sandbox, enforced'],
      ['Claude', '2.1.330'],
      ['Passed', 'CI'],
      ['Missing', 'none'],
      ['Commits', 'b0b0b0b → c1c1c1c · 2 files'],
      ['Flagged', 'changed .github/workflows/ci.yml'],
    ]));

  it('host reads as a convention', () =>
    expect(writeRows(FIX_ON_HOST)[0]).toEqual(['Environment', 'my-machine · host, a convention']));

  it('says what it does not know, and only what was recorded', () => {
    expect(writeRows(FIX_ON_HOST)).toEqual([
      ['Environment', 'my-machine · host, a convention'],
      ['Passed', 'none'],
      ['Missing', 'CI'],
      ['Commits', 'b0b0b0b → c1c1c1c · 2 files'],
      ['Flagged', 'changed .github/workflows/ci.yml'],
    ]);
    // Started, nothing committed yet (running, or failed with its changes kept apart).
    expect(writeRows(step({ kind: 'agent', checkout: { before: 'b0b0b0b0' } }))).toEqual([
      ['Commits', 'started at b0b0b0b, nothing committed'],
    ]);
    // A command in a run's own checkout: its commits, no environment (3-B runs commands on host).
    expect(
      writeRows(step({ checkout: { before: 'c1c1c1c1', after: 'c1c1c1c1', files: 0 } })),
    ).toEqual([['Commits', 'c1c1c1c → c1c1c1c · 0 files']]);
    expect(writeRows(step())).toEqual([]);
  });
});

describe("what a write step's detail opens (slice 3-B Task 22)", () => {
  it('a kept patch reads as a diff, in a fence no line of it can close', () => {
    expect(diffMarkdown('-a\n+b\n')).toBe('```diff\n-a\n+b\n```');
    expect(diffMarkdown('+```js\n+x\n')).toBe('````diff\n+```js\n+x\n````');
  });

  it('a path artifact is titled with its path', () => {
    const paths = [{ name: 'notes', path: 'docs/fixes/SHOP-42.md' }];
    expect(artifactTitle('notes', paths)).toBe('notes · docs/fixes/SHOP-42.md');
    expect(artifactTitle('handover', paths)).toBe('handover');
    expect(artifactTitle('notes', undefined)).toBe('notes');
  });

  it('a running write step is not said to work read-only', () => {
    const run = { status: 'running' as const, steps: [], startedAt: NOW.toISOString() };
    expect(stepSummary(step({ kind: 'agent', status: 'running' }), run, NOW)).toBe(
      'Working in a read-only session',
    );
    expect(stepSummary(step({ kind: 'agent', status: 'running', tools: 'write' }), run, NOW)).toBe(
      "Working in this run's checkout",
    );
  });
});
