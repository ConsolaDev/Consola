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
  entryMayRetry,
  RETRY_BACKOFF_MS,
  retriesSpentError,
  retryDelayMs,
  stepMayRetry,
} from './retry';

/*
 * What may start again by itself (slice 3, Call 8): a step whose failure
 * cannot have acted, and a whole run in which nothing acted. Decided from the
 * record alone; the clock is the caller's.
 */

const T0 = '2026-11-22T09:00:00.000Z';

const agentStep = (onFailure?: { retry: number }, id = 'look'): AgentStep => ({
  kind: 'agent',
  id,
  named: true,
  prompt: 'Look into it.',
  outputs: {},
  artifacts: [],
  reads: [],
  handover: 'optional',
  ...(onFailure ? { onFailure } : {}),
});
const commandStep = (
  options: { retry?: number; dryRun?: 'run' | 'report' } = {},
  id = 'pr',
): CommandStep => ({
  kind: 'run',
  id,
  named: true,
  run: 'gh pr create',
  env: {},
  outputs: {},
  timeoutMs: 600_000,
  dryRun: options.dryRun ?? 'report',
  ...(options.retry !== undefined ? { onFailure: { retry: options.retry } } : {}),
});
const gateStep = (id = 'decide'): GateStep => ({
  kind: 'gate',
  id,
  named: true,
  ask: 'Post it?',
  show: [],
});

const failed = (extra: Partial<StepRun> = {}): StepRun => ({
  id: 'look',
  kind: 'agent',
  status: 'failed',
  attempt: 1,
  error: 'exit 1',
  ...extra,
});

/** `look` names a server; `read` and `fresh` cannot act; `pr` may; `decide` asks a person; `polish` loops over them. */
const POLISH: RepeatStep = {
  kind: 'repeat',
  id: 'polish',
  named: true,
  max: 2,
  until: 'steps.read.done',
  steps: [agentStep(undefined, 'read'), commandStep({ dryRun: 'run' }, 'fresh'), gateStep('ask')],
};
const ENTRIES: StepEntry[] = [agentStep(), gateStep(), POLISH, commandStep()];

const row = (id: string, kind: StepRun['kind'], extra: Partial<StepRun> = {}): StepRun => ({
  id,
  kind,
  status: 'failed',
  attempt: 1,
  ...extra,
});
const cmdRow = (extra: Partial<StepRun> & { step?: string; intentAt?: string } = {}): StepRun => {
  const { step = 'pr', intentAt, ...rest } = extra;
  return row(step, 'run', {
    ...(intentAt ? { command: { envNames: [], intentAt } } : {}),
    ...rest,
  });
};
const agentRow = (extra: Partial<StepRun> & { step?: string } = {}): StepRun => {
  const { step = 'look', ...rest } = extra;
  return row(step, 'agent', rest);
};
const gateRow = (extra: Partial<StepRun> & { decision?: string } = {}): StepRun => {
  const { decision, ...rest } = extra;
  return row('decide', 'gate', {
    status: 'completed',
    ...(decision ? { gate: { askedAt: T0, decision, by: 'person', at: T0 } } : {}),
    ...rest,
  });
};

describe('stepMayRetry', () => {
  it.each<[string, AgentStep | CommandStep, StepRun, boolean, boolean]>([
    ['a read-only agent naming no server', agentStep({ retry: 1 }), failed(), false, true],
    ['an agent naming a server', agentStep({ retry: 1 }), failed(), true, false],
    [
      'a dry_run: run command that exited',
      commandStep({ retry: 1, dryRun: 'run' }),
      failed({ kind: 'run', command: { envNames: [], exitCode: 1 } }),
      false,
      true,
    ],
    [
      'a dry_run: run command a signal ended (its timeout)',
      commandStep({ retry: 1, dryRun: 'run' }),
      failed({ kind: 'run', command: { envNames: [], intentAt: T0, signal: 'SIGTERM' } }),
      false,
      true,
    ],
    [
      'a dry_run: run command with intent and no result',
      commandStep({ retry: 1, dryRun: 'run' }),
      failed({ kind: 'run', command: { envNames: [], intentAt: T0 } }),
      false,
      false,
    ],
    [
      'a dry_run: run command that never ran',
      commandStep({ retry: 1, dryRun: 'run' }),
      failed({ kind: 'run' }),
      false,
      false,
    ],
    [
      'any other command',
      commandStep({ retry: 1, dryRun: 'report' }),
      failed({ kind: 'run', command: { envNames: [], exitCode: 1 } }),
      false,
      false,
    ],
    ['retries spent', agentStep({ retry: 1 }), failed({ retries: 1 }), false, false],
    ['a retry left of two', agentStep({ retry: 2 }), failed({ retries: 1 }), false, true],
    ['no declared retry', agentStep(), failed(), false, false],
    ['a declared retry of 0', agentStep({ retry: 0 }), failed(), false, false],
  ])('a step: %s', (_, step, record, agentNamesServer, expected) => {
    expect(
      stepMayRetry({ step, record, agentNamesServer, stoppedByPerson: false, overBudget: false }),
    ).toBe(expected);
  });

  it('never after a person stopped it or over budget', () => {
    const input = { step: agentStep({ retry: 3 }), record: failed(), agentNamesServer: false };
    expect(stepMayRetry({ ...input, stoppedByPerson: true, overBudget: false })).toBe(false);
    expect(stepMayRetry({ ...input, stoppedByPerson: false, overBudget: true })).toBe(false);
  });

  it('never for a gate, which asks a person and runs nothing', () => {
    expect(
      stepMayRetry({
        step: gateStep(),
        record: row('decide', 'gate'),
        agentNamesServer: false,
        stoppedByPerson: false,
        overBudget: false,
      }),
    ).toBe(false);
  });
});

describe('entryMayRetry', () => {
  const entry = (
    records: StepRun[],
    over: Partial<Parameters<typeof entryMayRetry>[0]> = {},
  ): boolean =>
    entryMayRetry({
      declared: 1,
      retried: 0,
      entries: ENTRIES,
      records,
      agentNamesServer: (id) => id === 'look',
      stoppedByPerson: false,
      overBudget: false,
      ...over,
    });

  it.each<[string, StepRun[], boolean]>([
    ['nothing acted', [], true],
    ["a command's intent", [cmdRow({ intentAt: T0, step: 'pr' })], false],
    ['an agent naming a server started', [agentRow({ startedAt: T0, step: 'look' })], false],
    ['an answered gate', [gateRow({ decision: 'approve' })], false],
    // review S6: what acted in an earlier round is only a `previous` line now
    [
      "a command's earlier round",
      [
        cmdRow({
          step: 'pr',
          status: 'pending',
          attempt: 2,
          previous: [{ attempt: 1, status: 'completed', round: 1 }],
        }),
      ],
      false,
    ],
    [
      "an earlier round's dry run only",
      [
        cmdRow({
          step: 'pr',
          status: 'pending',
          attempt: 2,
          previous: [{ attempt: 1, status: 'reported', round: 1 }],
        }),
      ],
      true,
    ],
    [
      "a server agent's earlier round",
      [
        agentRow({
          step: 'look',
          status: 'pending',
          attempt: 2,
          previous: [{ attempt: 1, status: 'failed', round: 1 }],
        }),
      ],
      false,
    ],
    [
      'a gate answered in an earlier round',
      [
        gateRow({
          status: 'pending',
          attempt: 2,
          previous: [{ attempt: 1, status: 'completed', round: 1, decision: 'approve' }],
        }),
      ],
      false,
    ],
  ])('the entry: %s', (_, rows, expected) => {
    expect(entry(rows)).toBe(expected);
  });

  it.each<[string, StepRun[]]>([
    ['a read-only agent naming no server started', [agentRow({ step: 'read', startedAt: T0 })]],
    ['a dry_run: run command recorded intent', [cmdRow({ step: 'fresh', intentAt: T0 })]],
    [
      'a dry_run: run command ran in an earlier round',
      [
        cmdRow({
          step: 'fresh',
          status: 'pending',
          attempt: 2,
          previous: [{ attempt: 1, status: 'completed' }],
        }),
      ],
    ],
    [
      'a gate asked and never answered',
      [row('decide', 'gate', { status: 'waiting', gate: { askedAt: T0 } })],
    ],
    ['a command that never got to run', [cmdRow({ step: 'pr', status: 'not-run' })]],
    [
      'earlier attempts that did not run: not-run, skipped, pending',
      [
        cmdRow({
          step: 'pr',
          status: 'pending',
          attempt: 4,
          previous: [
            { attempt: 1, status: 'not-run' },
            { attempt: 2, status: 'skipped' },
            { attempt: 3, status: 'pending' },
          ],
        }),
      ],
    ],
    ['a server agent that never started', [agentRow({ step: 'look', status: 'not-run' })]],
    [
      "a loop's own row",
      [row('polish', 'repeat', { startedAt: T0, previous: [{ attempt: 1, status: 'failed' }] })],
    ],
  ])('the entry may start again after %s', (_, rows) => {
    expect(entry(rows)).toBe(true);
  });

  it('reads a gate answered inside a loop, and a step it does not know, as having acted', () => {
    expect(
      entry([
        row('ask', 'gate', { status: 'completed', gate: { askedAt: T0, decision: 'approve' } }),
      ]),
    ).toBe(false);
    // A row the definition does not name (a record older than its snapshot): what it was cannot be told, so it may have acted.
    expect(entry([agentRow({ step: 'gone', startedAt: T0 })])).toBe(false);
  });

  it('never once its retries are spent, after a stop, or over budget', () => {
    expect(entry([], { retried: 1 })).toBe(false);
    expect(entry([], { declared: 0 })).toBe(false);
    expect(entry([], { declared: 3, retried: 2 })).toBe(true);
    expect(entry([], { stoppedByPerson: true })).toBe(false);
    expect(entry([], { overBudget: true })).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('backs off 1, 5, 15 minutes, or the override', () => {
    expect(RETRY_BACKOFF_MS).toEqual([60_000, 300_000, 900_000]);
    expect([0, 1, 2, 3].map((n) => retryDelayMs(n))).toEqual([60_000, 300_000, 900_000, 900_000]);
    expect(retryDelayMs(2, 500)).toBe(500);
    expect(retryDelayMs(0, 500)).toBe(500);
  });
});

describe('retriesSpentError', () => {
  it('says how many times it tried', () => {
    expect(retriesSpentError('exit 1', 3)).toBe('exit 1 (tried 3 times)');
    expect(retriesSpentError('exit 1', 1)).toBe('exit 1 (tried 1 time)');
  });
});
