import { describe, expect, it } from 'vitest';
import type { RunRecord, StepRun } from '@consola/factory-spec';
import {
  NO_TURN_TO_STOP,
  STOPPED_BEFORE_RETRY,
  STOPPED_WAITING_GATE,
  stopAction,
  stoppedBefore,
} from './stop';

const T0 = '2026-11-22T09:00:00.000Z';
const T1 = '2026-11-22T09:05:00.000Z';

function stepsRun(fields: Partial<RunRecord> & Pick<RunRecord, 'status'>): RunRecord {
  return {
    id: 'run-1',
    runner: 'local',
    source: 'personal',
    automationId: 'gated',
    actionName: 'steps',
    actionVersion: 'v1',
    mode: 'auto',
    trigger: { kind: 'manual', at: T0 },
    attribution: {
      automationId: 'gated',
      actionName: 'steps',
      triggerKind: 'manual',
      workspaceId: 'ws-1',
    },
    createdAt: T0,
    updatedAt: T0,
    result: { kind: 'steps-run' },
    ...fields,
  };
}

function row(
  id: string,
  kind: StepRun['kind'],
  status: StepRun['status'],
  fields: Partial<StepRun> = {},
): StepRun {
  return { id, kind, status, attempt: 1, ...fields };
}

const gateWaiting = (id: string): StepRun => row(id, 'gate', 'waiting', { gate: { askedAt: T0 } });

describe('stopAction', () => {
  it.each<[string, RunRecord, ReturnType<typeof stopAction>]>([
    [
      'a gate',
      stepsRun({
        status: 'waiting',
        steps: [row('review', 'agent', 'completed'), gateWaiting('decide')],
      }),
      { kind: 'end-wait', stepId: 'decide', error: 'Stopped while it waited for you.' },
    ],
    [
      "a loop's exhaustion gate",
      stepsRun({
        status: 'waiting',
        steps: [
          row('polish', 'repeat', 'waiting', { round: 3, max: 3, gate: { askedAt: T0 } }),
          row('review', 'agent', 'completed', { round: 3 }),
        ],
      }),
      { kind: 'end-wait', stepId: 'polish', error: 'Stopped while it waited for you.' },
    ],
    [
      'a step retry',
      stepsRun({
        status: 'waiting',
        steps: [row('look', 'agent', 'waiting', { retryAt: T1, retries: 1, error: 'x' })],
      }),
      { kind: 'end-wait', stepId: 'look', error: 'Stopped before its retry.' },
    ],
    [
      'a step retry inside a loop, not its loop row',
      stepsRun({
        status: 'waiting',
        steps: [
          row('polish', 'repeat', 'running', { round: 2, max: 3 }),
          row('look', 'agent', 'waiting', { round: 2, retryAt: T1, retries: 1, error: 'x' }),
        ],
      }),
      { kind: 'end-wait', stepId: 'look', error: 'Stopped before its retry.' },
    ],
    [
      "the run's retry, after a step failed",
      stepsRun({
        status: 'waiting',
        retryAt: T1,
        steps: [row('look', 'agent', 'failed', { error: 'x' })],
      }),
      { kind: 'end-wait', error: 'Stopped before its retry.' },
    ],
    [
      // review S9: the entry's retry after a checkout that could not be prepared, no row failed
      "the run's retry, before any step",
      stepsRun({
        status: 'waiting',
        retryAt: T1,
        steps: [row('fresh', 'run', 'pending'), row('review', 'agent', 'pending')],
      }),
      { kind: 'end-wait', error: 'Stopped before its retry.' },
    ],
  ])('stops a run waiting at %s', (_name, run, expected) => {
    expect(stopAction(run, { starting: false })).toEqual(expected);
  });

  it('pins the two waiting words', () => {
    expect(STOPPED_WAITING_GATE).toBe('Stopped while it waited for you.');
    expect(STOPPED_BEFORE_RETRY).toBe('Stopped before its retry.');
  });

  it.each<[string, RunRecord, { starting: boolean }, ReturnType<typeof stopAction>]>([
    [
      'waiting for approval',
      stepsRun({ status: 'needs-approval' }),
      { starting: false },
      { kind: 'dismiss' },
    ],
    ['in line', stepsRun({ status: 'queued' }), { starting: false }, { kind: 'dismiss' }],
    ['ended', stepsRun({ status: 'completed' }), { starting: false }, { kind: 'none' }],
    [
      'starting something',
      stepsRun({ status: 'running', steps: [row('a', 'agent', 'running')] }),
      { starting: true },
      { kind: 'defer' },
    ],
    [
      'an agent turn running',
      stepsRun({ status: 'running', steps: [row('a', 'agent', 'running', { sessionId: 's-1' })] }),
      { starting: false },
      { kind: 'end-turn', stepId: 'a', sessionId: 's-1' },
    ],
    [
      'an agent step with no session',
      stepsRun({ status: 'running', steps: [row('a', 'agent', 'running')] }),
      { starting: false },
      { kind: 'fail-step', stepId: 'a', error: NO_TURN_TO_STOP },
    ],
    [
      'a command running',
      stepsRun({ status: 'running', steps: [row('a', 'run', 'running')] }),
      { starting: false },
      { kind: 'stop-command', stepId: 'a' },
    ],
    [
      'a step in line for a slot',
      stepsRun({
        status: 'running',
        steps: [row('a', 'agent', 'completed'), row('b', 'run', 'queued')],
      }),
      { starting: false },
      { kind: 'fail-step', stepId: 'b', error: stoppedBefore('b') },
    ],
    [
      'between steps',
      stepsRun({
        status: 'running',
        steps: [row('a', 'agent', 'completed'), row('b', 'run', 'pending')],
      }),
      { starting: false },
      { kind: 'fail-next' },
    ],
  ])('keeps every earlier case: %s', (_name, run, inFlight, expected) => {
    expect(stopAction(run, inFlight)).toEqual(expected);
  });

  it('in a loop, ends the inner step that runs, not the loop row', () => {
    const run = stepsRun({
      status: 'running',
      steps: [
        row('polish', 'repeat', 'running', { round: 2, max: 3 }),
        row('review', 'agent', 'running', { round: 2, sessionId: 's-2' }),
        row('address', 'run', 'pending', { round: 2 }),
      ],
    });
    expect(stopAction(run, { starting: false })).toEqual({
      kind: 'end-turn',
      stepId: 'review',
      sessionId: 's-2',
    });
  });

  it("in a loop, a command in line is the one that fails, and between rounds it is the sequencer's", () => {
    const queued = stepsRun({
      status: 'running',
      steps: [
        row('polish', 'repeat', 'running', { round: 1, max: 3 }),
        row('review', 'agent', 'completed', { round: 1 }),
        row('address', 'run', 'queued', { round: 1 }),
      ],
    });
    expect(stopAction(queued, { starting: false })).toEqual({
      kind: 'fail-step',
      stepId: 'address',
      error: stoppedBefore('address'),
    });
    // The loop's row is running, but nothing in it is: the next move (a round, a gate) is failed by `advance`.
    const between = stepsRun({
      status: 'running',
      steps: [
        row('polish', 'repeat', 'running', { round: 1, max: 3 }),
        row('review', 'agent', 'completed', { round: 1 }),
      ],
    });
    expect(stopAction(between, { starting: false })).toEqual({ kind: 'fail-next' });
  });
});
