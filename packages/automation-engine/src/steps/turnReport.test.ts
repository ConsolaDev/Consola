import { describe, expect, it } from 'vitest';
import { parseFactorySpec, type StepRun, type StepsAutomation } from '@consola/factory-spec';
import type { TurnOutcome, TurnReportView, TurnResultView } from '../views';
import type { RunDefinition } from './definition';
import {
  ERROR_LINE_MAX,
  initProblem,
  reminderCap,
  reportedFailure,
  requiredServers,
  runCostOf,
  turnFailure,
  withTurnRecorded,
} from './turnReport';

const report = (fields: Partial<TurnReportView> = {}): TurnReportView => ({
  otherLines: [],
  raw: {},
  ...fields,
});
const result = (fields: Partial<TurnResultView>): TurnResultView => ({
  subtype: 'success',
  isError: false,
  deniedTools: [],
  ...fields,
});

const LONG = 'x'.repeat(1000);
const CUT = `${'x'.repeat(ERROR_LINE_MAX)}…`;

describe('reportedFailure', () => {
  it.each<[string, TurnOutcome & { report: TurnReportView }, ReturnType<typeof reportedFailure>]>([
    [
      'a stop is a stop, whatever the report says',
      {
        exitCode: 0,
        stopped: 'you pressed Ctrl+C',
        report: report({ result: result({ text: 'FINDINGS: done' }) }),
      },
      { error: 'It stopped before finishing: you pressed Ctrl+C.', atTurnLimit: false },
    ],
    [
      'error_max_turns names the cap the turn ran with',
      {
        exitCode: 1,
        report: report({
          maxTurns: 6,
          result: result({ subtype: 'error_max_turns', isError: true }),
        }),
      },
      { error: 'It hit its limit of 6 turns before finishing.', atTurnLimit: true },
    ],
    [
      'error_max_turns without a known cap',
      {
        exitCode: 1,
        report: report({ result: result({ subtype: 'error_max_turns', isError: true }) }),
      },
      { error: 'It hit its turn limit before finishing.', atTurnLimit: true },
    ],
    [
      'is_error with success fails, in the CLI’s own words',
      {
        exitCode: 1,
        report: report({
          result: result({ isError: true, text: 'Not logged in · Please run /login' }),
        }),
      },
      {
        error: 'It stopped before finishing: Not logged in · Please run /login.',
        atTurnLimit: false,
      },
    ],
    [
      'is_error with no text names the API error',
      { exitCode: 1, report: report({ result: result({ isError: true, apiErrorStatus: 529 }) }) },
      { error: 'It stopped before finishing: API error 529.', atTurnLimit: false },
    ],
    [
      'is_error with no text and no status names the subtype',
      {
        exitCode: 1,
        report: report({ result: result({ isError: true, subtype: 'error_during_execution' }) }),
      },
      {
        error: 'It stopped before finishing: the CLI reported error_during_execution.',
        atTurnLimit: false,
      },
    ],
    [
      'a subtype that is not success fails even without is_error',
      {
        exitCode: 0,
        report: report({ result: result({ isError: false, subtype: 'error_during_execution' }) }),
      },
      {
        error: 'It stopped before finishing: the CLI reported error_during_execution.',
        atTurnLimit: false,
      },
    ],
    [
      'no result, a non-zero exit: the last line the CLI printed outside JSON',
      { exitCode: 1, report: report({ otherLines: ['Warning: x', 'TypeError: boom'] }) },
      { error: 'It stopped before finishing (exit 1): TypeError: boom.', atTurnLimit: false },
    ],
    [
      'no result, exit 0, nothing printed',
      { exitCode: 0, report: report() },
      { error: 'It ended without reporting how its turn went.', atTurnLimit: false },
    ],
    [
      'no result, exit 0, a line printed',
      { exitCode: 0, report: report({ otherLines: ['Segmentation fault'] }) },
      {
        error: 'It ended without reporting how its turn went: Segmentation fault.',
        atTurnLimit: false,
      },
    ],
    [
      'a clean result and a non-zero exit',
      { exitCode: 1, report: report({ result: result({ text: 'FINDINGS: done' }) }) },
      { error: 'It stopped before finishing (exit 1): FINDINGS: done.', atTurnLimit: false },
    ],
    [
      'a clean result and a non-zero exit, with a line printed after it',
      {
        exitCode: 1,
        report: report({
          result: result({ text: 'FINDINGS: done' }),
          otherLines: ['Error: EPIPE'],
        }),
      },
      { error: 'It stopped before finishing (exit 1): Error: EPIPE.', atTurnLimit: false },
    ],
    [
      'a long line is cut (exit 1)',
      { exitCode: 1, report: report({ otherLines: [LONG] }) },
      { error: `It stopped before finishing (exit 1): ${CUT}.`, atTurnLimit: false },
    ],
    [
      'a long line is cut (exit 0)',
      { exitCode: 0, report: report({ otherLines: [LONG] }) },
      { error: `It ended without reporting how its turn went: ${CUT}.`, atTurnLimit: false },
    ],
    [
      'a long result text is cut',
      { exitCode: 1, report: report({ result: result({ isError: true, text: LONG }) }) },
      { error: `It stopped before finishing: ${CUT}.`, atTurnLimit: false },
    ],
    [
      'a reason’s own full stop is not doubled',
      {
        exitCode: 1,
        report: report({ result: result({ isError: true, text: 'Rate limited. ' }) }),
      },
      { error: 'It stopped before finishing: Rate limited.', atTurnLimit: false },
    ],
    [
      'never the pane’s lines: Consola’s summary is not the CLI’s',
      { exitCode: 1, lastLine: 'Finished: 3 turns.', report: report() },
      { error: 'It stopped before finishing (exit 1).', atTurnLimit: false },
    ],
    [
      'a clean result and exit 0 succeeded',
      { exitCode: 0, report: report({ result: result({ text: 'FINDINGS: done' }) }) },
      null,
    ],
  ])('%s', (_name, outcome, expected) => {
    expect(reportedFailure(outcome)).toEqual(expected);
  });

  it('a reminder that hit its own cap says so, not the step’s limit', () => {
    const atCap = (maxTurns?: number) => ({
      exitCode: 1,
      report: report({
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        result: result({ subtype: 'error_max_turns', isError: true }),
      }),
    });
    expect(reportedFailure(atCap(3), { reminder: true })).toEqual({
      error: 'Its reminder hit its limit of 3 turns before finishing.',
      atTurnLimit: true,
    });
    expect(reportedFailure(atCap(), { reminder: true })).toEqual({
      error: 'Its reminder hit its turn limit before finishing.',
      atTurnLimit: true,
    });
    // The first turn keeps the step's words.
    expect(reportedFailure(atCap(6), { reminder: false })?.error).toBe(
      'It hit its limit of 6 turns before finishing.',
    );
  });
});

describe('turnFailure keeps its words', () => {
  it('a stop', () => {
    expect(turnFailure({ exitCode: 0, stopped: 'you stopped it.' })).toBe(
      'It stopped before finishing: you stopped it.',
    );
  });
  it('a clean exit', () => {
    expect(turnFailure({ exitCode: 0, lastLine: 'Done.' })).toBeNull();
  });
  it('a non-zero exit, with its last line', () => {
    expect(turnFailure({ exitCode: 2, lastLine: 'Error: boom. ' })).toBe(
      'It stopped before finishing (exit 2): Error: boom.',
    );
    expect(turnFailure({ exitCode: 2 })).toBe('It stopped before finishing (exit 2).');
  });
});

describe('reminderCap', () => {
  it('caps the reminder at 1 + 2 per missing item', () => {
    expect(reminderCap({ outputs: ['verdict'], artifacts: [] })).toBe(3);
    expect(reminderCap({ outputs: [], artifacts: ['handover'] })).toBe(3);
    expect(reminderCap({ outputs: ['a', 'b'], artifacts: ['handover'] })).toBe(5);
    expect(reminderCap({ outputs: [], artifacts: ['handover', 'notes'] })).toBe(5);
  });
});

describe('requiredServers', () => {
  it('is empty until agents grant servers', () => {
    const automation = parseFactorySpec(`version: 1
automations:
  - name: nightly
    on: { cron: "0 9 * * 1-5" }
    scope: api
    steps:
      - id: research
        prompt: Read what changed in api overnight.
`).automations[0] as StepsAutomation;
    const definition: RunDefinition = { automation, version: 'v', actions: {} };
    expect(requiredServers(definition, 'research')).toEqual([]);
  });
});

describe('initProblem', () => {
  const hint = 'run `claude`, then /mcp';

  it('has nothing to check when no server is required', () => {
    expect(initProblem([], { servers: [] }, 'Stub')).toBeNull();
    expect(
      initProblem([], { servers: [{ name: 'grafana', status: 'failed' }] }, 'Stub'),
    ).toBeNull();
  });

  it('a required server missing from init was not loaded', () => {
    expect(
      initProblem(
        [{ name: 'grafana' }],
        { servers: [{ name: 'consola', status: 'connected' }] },
        'Stub',
      ),
    ).toBe('`grafana` was not loaded: it was removed from Stub, or it is blocked by its URL.');
  });

  it.each(['needs-auth', 'failed', 'pending'])(
    'a required server that is %s was not connected',
    (status) => {
      expect(
        initProblem(
          [{ name: 'grafana' }],
          { servers: [{ name: 'grafana', status }], signInHint: hint },
          'Stub',
        ),
      ).toBe(
        `\`grafana\` was not connected (${status}). Sign in to it in Stub (run \`claude\`, then /mcp), then retry this step.`,
      );
    },
  );

  it('without a hint, the sign-in sentence has no brackets', () => {
    expect(
      initProblem(
        [{ name: 'grafana' }],
        { servers: [{ name: 'grafana', status: 'failed' }] },
        'Stub',
      ),
    ).toBe('`grafana` was not connected (failed). Sign in to it in Stub, then retry this step.');
  });

  it('a connected server is no problem', () => {
    expect(
      initProblem(
        [{ name: 'grafana' }],
        { servers: [{ name: 'grafana', status: 'connected' }], signInHint: hint },
        'Stub',
      ),
    ).toBeNull();
  });
});

describe('withTurnRecorded', () => {
  const fresh: StepRun = { id: 'one', kind: 'agent', status: 'running', attempt: 1 };

  it('records a turn’s figures, the step’s cap and the model', () => {
    const recorded = withTurnRecorded(
      fresh,
      report({
        init: { model: 'claude-opus-5-5', servers: [] },
        result: result({ costUsd: 0.0123, turns: 3, deniedTools: ['mcp__a__b'] }),
      }),
      6,
    );
    expect(recorded.turn).toEqual({
      costUsd: 0.0123,
      turns: 3,
      maxTurns: 6,
      deniedTools: ['mcp__a__b'],
    });
    expect(recorded.model).toBe('claude-opus-5-5');
  });

  it('sums turns and keeps denied tools distinct, in first-seen order', () => {
    const first = withTurnRecorded(
      fresh,
      report({ result: result({ costUsd: 0.0123, turns: 3, deniedTools: ['mcp__a__b'] }) }),
      6,
    );
    // A resumed turn reports the conversation's running cost (canary row 14).
    const second = withTurnRecorded(
      first,
      report({ result: result({ costUsd: 0.0223, turns: 2, deniedTools: ['mcp__a__b', 'Read'] }) }),
      6,
    );
    expect(second.turn?.costUsd).toBeCloseTo(0.0223, 10);
    expect(second.turn?.turns).toBe(5);
    expect(second.turn?.deniedTools).toEqual(['mcp__a__b', 'Read']);
  });

  it('a resumed turn’s cost is the conversation’s running total: the step records the difference', () => {
    // Canary row 14 (2.1.330): the reminder's total_cost_usd includes the first turn's.
    const first = withTurnRecorded(
      fresh,
      report({ result: result({ costUsd: 0.0015, turns: 1 }) }),
      undefined,
    );
    const reminder = withTurnRecorded(
      first,
      report({ result: result({ costUsd: 0.003, turns: 1 }) }),
      undefined,
    );
    expect(reminder.turn?.costUsd).toBeCloseTo(0.003, 10);
    expect(reminder.turn?.costUsd).not.toBeCloseTo(0.0045, 10);
    expect(reminder.turn?.turns).toBe(2);
  });

  it('a total below what the attempt recorded is a conversation that started over: its total is the turn’s own', () => {
    const first = withTurnRecorded(fresh, report({ result: result({ costUsd: 0.01 }) }), undefined);
    const over = withTurnRecorded(first, report({ result: result({ costUsd: 0.004 }) }), undefined);
    expect(over.turn?.costUsd).toBeCloseTo(0.014, 10);
  });

  it('a turn that reports no cost leaves the cost as it was', () => {
    const none = withTurnRecorded(fresh, report({ result: result({ turns: 1 }) }), undefined);
    expect(none.turn).toEqual({ turns: 1 });
    expect(Object.prototype.hasOwnProperty.call(none.turn, 'costUsd')).toBe(false);
    const costed = withTurnRecorded(
      fresh,
      report({ result: result({ costUsd: 0.02 }) }),
      undefined,
    );
    const after = withTurnRecorded(costed, report({ result: result({ turns: 1 }) }), undefined);
    expect(after.turn?.costUsd).toBe(0.02);
  });

  it('a reported 0 is recorded as 0', () => {
    const zero = withTurnRecorded(fresh, report({ result: result({ costUsd: 0 }) }), undefined);
    expect(zero.turn?.costUsd).toBe(0);
  });

  it('a report with no result adds nothing to the turn', () => {
    expect(
      withTurnRecorded(fresh, report({ otherLines: ['TypeError: boom'] }), 6).turn,
    ).toBeUndefined();
    const before: StepRun = { ...fresh, turn: { costUsd: 0.01, turns: 2, maxTurns: 6 } };
    expect(withTurnRecorded(before, report(), 6).turn).toEqual(before.turn);
  });

  it('no init leaves the model as it was, and an init without one too', () => {
    const modelled: StepRun = { ...fresh, model: 'claude-haiku-5-5' };
    expect(withTurnRecorded(modelled, report({ result: result({}) }), undefined).model).toBe(
      'claude-haiku-5-5',
    );
    expect(
      withTurnRecorded(modelled, report({ init: { servers: [] }, result: result({}) }), undefined)
        .model,
    ).toBe('claude-haiku-5-5');
  });

  it('a result with no figures leaves no turn', () => {
    expect(withTurnRecorded(fresh, report({ result: result({}) }), undefined).turn).toBeUndefined();
  });

  it('no step cap leaves maxTurns absent', () => {
    const recorded = withTurnRecorded(fresh, report({ result: result({ turns: 1 }) }), undefined);
    expect(recorded.turn).toEqual({ turns: 1 });
  });

  it('changes nothing else on the record', () => {
    const record: StepRun = { ...fresh, outputs: { mood: 'calm' }, sessionId: 'session-1' };
    const recorded = withTurnRecorded(
      record,
      report({ result: result({ costUsd: 0.01 }) }),
      undefined,
    );
    const { turn: _turn, ...rest } = recorded;
    expect(rest).toEqual(record);
  });
});

describe('runCostOf', () => {
  it('sums every step’s turn and every earlier attempt', () => {
    const steps: StepRun[] = [
      { id: 'a', kind: 'agent', status: 'completed', attempt: 1, turn: { costUsd: 0.01 } },
      { id: 'b', kind: 'agent', status: 'completed', attempt: 1, turn: { costUsd: 0.02 } },
      {
        id: 'c',
        kind: 'agent',
        status: 'running',
        attempt: 2,
        previous: [{ attempt: 1, status: 'failed', costUsd: 0.005 }],
      },
      { id: 'd', kind: 'run', status: 'completed', attempt: 1 },
    ];
    expect(runCostOf(steps)).toBeCloseTo(0.035, 10);
  });

  it('is undefined while nothing reported a cost', () => {
    expect(
      runCostOf([{ id: 'a', kind: 'agent', status: 'completed', attempt: 1, turn: { turns: 2 } }]),
    ).toBeUndefined();
    expect(runCostOf([])).toBeUndefined();
  });

  it('a single reported 0 is 0', () => {
    expect(
      runCostOf([
        { id: 'a', kind: 'agent', status: 'completed', attempt: 1, turn: { costUsd: 0 } },
      ]),
    ).toBe(0);
  });
});
