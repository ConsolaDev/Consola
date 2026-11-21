import { describe, expect, it } from 'vitest';
import type { RunRecord, StepRun } from '@consola/factory-spec';
import { INTERRUPTED_COMMAND, isEngineRun, recoverAfterRestart } from './recover';

const NOW = '2026-11-14T12:00:00.000Z';
const EARLIER = '2026-11-14T11:00:00.000Z';

function base(fields: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    runner: 'local',
    source: 'personal',
    automationId: 'auto',
    actionName: 'prompt',
    actionVersion: 'v1',
    mode: 'auto',
    trigger: { kind: 'manual', at: EARLIER },
    status: 'running',
    attribution: {
      automationId: 'auto',
      actionName: 'prompt',
      triggerKind: 'manual',
      workspaceId: 'ws-1',
    },
    createdAt: EARLIER,
    updatedAt: EARLIER,
    ...fields,
  };
}

function stepsRun(steps: StepRun[], fields: Partial<RunRecord> = {}): RunRecord {
  return base({ result: { kind: 'steps-run' }, steps, ...fields });
}

const agentStep = (fields: Partial<StepRun> = {}): StepRun => ({
  id: 'review',
  kind: 'agent',
  status: 'running',
  attempt: 2,
  sessionId: 'sess-1',
  startedAt: EARLIER,
  outputs: { verdict: 'ok' },
  artifacts: [{ name: 'notes.md', bytes: 12 }],
  ...fields,
});

const commandStep = (fields: Partial<StepRun> = {}): StepRun => ({
  id: 'post',
  kind: 'run',
  status: 'running',
  attempt: 1,
  startedAt: EARLIER,
  command: { envNames: ['URL'], intentAt: EARLIER },
  ...fields,
});

const pending = (id: string): StepRun => ({ id, kind: 'agent', status: 'pending', attempt: 1 });

describe('recoverAfterRestart', () => {
  const rows: Array<[string, RunRecord, RunRecord | null]> = [
    [
      'a legacy agent run running goes back to queued',
      base({ result: { kind: 'agent-run' } }),
      base({ result: { kind: 'agent-run' }, status: 'queued', updatedAt: NOW }),
    ],
    [
      'an agent step running with a session goes back to queued, keeping everything',
      stepsRun([agentStep()]),
      stepsRun([agentStep({ status: 'queued' })]),
    ],
    [
      'an agent step queued with a session is unchanged',
      stepsRun([agentStep({ status: 'queued' })]),
      null,
    ],
    [
      'a command step with intent and no result fails the run, never re-run',
      stepsRun([commandStep(), pending('after')]),
      stepsRun(
        [
          commandStep({ status: 'failed', error: INTERRUPTED_COMMAND, finishedAt: NOW }),
          { ...pending('after'), status: 'not-run' },
        ],
        {
          status: 'failed',
          error: INTERRUPTED_COMMAND,
          updatedAt: NOW,
          finishedAt: NOW,
        },
      ),
    ],
    [
      'a command step running without intent goes back to queued, run stays running',
      stepsRun([commandStep({ command: { envNames: [] } })]),
      stepsRun([commandStep({ status: 'queued', command: { envNames: [] } })]),
    ],
    [
      'a step queued without a session or intent is unchanged',
      stepsRun([{ id: 's', kind: 'agent', status: 'queued', attempt: 1 }]),
      null,
    ],
    [
      'a run between steps is unchanged',
      stepsRun([{ ...agentStep(), status: 'completed' }, pending('next')]),
      null,
    ],
    ['a queued run is unchanged', stepsRun([pending('s')], { status: 'queued' }), null],
    [
      'a needs-approval run is unchanged',
      base({ status: 'needs-approval', approval: { args: {} } }),
      null,
    ],
    [
      'a tool run running fails as interrupted, its approval dropped',
      base({ approval: { args: { a: 1 } } }),
      base({
        status: 'failed',
        error: 'Interrupted: Consola quit while this was running.',
        updatedAt: NOW,
        finishedAt: NOW,
      }),
    ],
    ['a finished run is unchanged', base({ status: 'completed', finishedAt: EARLIER }), null],
  ];

  it.each(rows)('%s', (_name, input, expected) => {
    const before = JSON.stringify(input);
    expect(recoverAfterRestart(input, NOW)).toEqual(expected);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    ['an exit code', { exitCode: 0 }, 'exit 0'],
    ['a signal', { signal: 'SIGKILL' }, 'SIGKILL'],
  ])(
    'fails a command step that has %s but was never settled, never re-queueing it',
    (_name, result, how) => {
      const error = `Consola quit while recording this command's result (${how}). It ran; check what it did, then retry.`;
      const done = commandStep({ command: { envNames: [], intentAt: EARLIER, ...result } });
      expect(
        recoverAfterRestart(stepsRun([done, pending('after')], { approval: { args: {} } }), NOW),
      ).toEqual(
        stepsRun(
          [
            { ...done, status: 'failed', error, finishedAt: NOW },
            { ...pending('after'), status: 'not-run' },
          ],
          {
            status: 'failed',
            error,
            updatedAt: NOW,
            finishedAt: NOW,
          },
        ),
      );
    },
  );

  it('pins the interrupted-command copy', () => {
    expect(INTERRUPTED_COMMAND).toBe(
      'Interrupted: Consola quit while this command was running. It may or may not have finished; check, then retry.',
    );
  });

  it('knows an engine run by its result kind', () => {
    expect(isEngineRun(base({ result: { kind: 'agent-run' } }))).toBe(true);
    expect(isEngineRun(base({ result: { kind: 'steps-run' } }))).toBe(true);
    expect(isEngineRun(base({ result: { kind: 'other' } }))).toBe(false);
    expect(isEngineRun(base())).toBe(false);
  });
});
