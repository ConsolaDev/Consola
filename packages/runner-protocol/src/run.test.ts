import { describe, expect, it } from 'vitest';
import {
  RUN_STEPS_MAX,
  type RunRecord,
  readRunRecord,
  STEP_ARTIFACTS_MAX,
  STEP_DENIED_TOOLS_MAX,
  STEP_OUTPUTS_MAX,
  STEP_PREVIOUS_MAX,
  type StepRecord,
} from './run.js';

/** What the other side really sends: the value after `JSON.stringify` and `JSON.parse`. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const step: StepRecord = {
  id: 'review',
  kind: 'agent',
  status: 'completed',
  attempt: 2,
  agent: 'reviewer',
  model: 'claude-sonnet-5',
  startedAt: '2026-11-25T10:00:00.000Z',
  finishedAt: '2026-11-25T10:04:00Z',
  costUsd: 0.42,
  error: null,
  skipped: null,
  outputs: { verdict: 'approve', score: 9, blocking: false },
  artifacts: [{ name: 'handover', bytes: 1200 }],
  turn: { turns: 7, maxTurns: 20, deniedTools: ['WebFetch'] },
  command: null,
  previous: [
    {
      attempt: 1,
      status: 'failed',
      error: 'The turn ran out.',
      finishedAt: '2026-11-25T09:59:00Z',
      costUsd: 0.1,
      turns: 20,
    },
  ],
  reminded: true,
  output: { stdout: 'Reviewed 4 files.\n', stderr: '', truncated: false },
};

const commandStep: StepRecord = {
  ...step,
  id: 'test',
  kind: 'run',
  status: 'failed',
  attempt: 1,
  agent: null,
  model: null,
  costUsd: null,
  error: 'The command exited with 1.',
  outputs: null,
  artifacts: [],
  turn: null,
  command: { exitCode: 1, signal: null, stdoutBytes: 300, stderrBytes: 20, truncated: false },
  previous: [],
  reminded: false,
};

const run: RunRecord = {
  id: 'run-1',
  factoryId: 'factory-1',
  factoryVersion: 3,
  parent: null,
  automation: 'review-pr',
  status: 'needs-approval',
  waitingOn: null,
  trigger: 'event',
  triggerDetail: 'pull_request.opened',
  startedBy: null,
  item: {
    url: 'https://github.com/sprocket/catalog-portal/pull/12',
    title: 'Fix the cart',
    kind: 'pr',
    repo: 'sprocket/catalog-portal',
    number: 12,
  },
  runner: 'cloud',
  steps: [step, commandStep],
  request: null,
  summary: null,
  error: null,
  costUsd: 0.52,
  createdAt: '2026-11-25T09:58:00.000Z',
  startedAt: null,
  finishedAt: null,
  updatedAt: '2026-11-25T10:04:00.000Z',
};

const request: RunRecord = {
  ...run,
  id: 'request-1',
  automation: null,
  status: 'waiting',
  waitingOn: 'run',
  trigger: 'manual',
  triggerDetail: null,
  startedBy: 'person-1',
  item: null,
  steps: [{ ...step, id: 'orchestrator', kind: 'orchestrator', status: 'waiting' }],
  request: {
    text: 'Tidy the catalog portal.',
    budget: { usd: 5, runs: 3 },
    spent: { usd: 0.5, runs: 1 },
    question: { at: '2026-11-25T10:00:00Z', until: '2026-11-26T10:00:00Z' },
  },
};

const child: RunRecord = { ...run, id: 'run-2', parent: { runId: 'request-1', move: 2 } };

/** `run` with one field of one step replaced. */
const withStep = (patch: Record<string, unknown>) => ({ ...run, steps: [{ ...step, ...patch }] });

describe('readRunRecord', () => {
  it.each([
    ['an automation run', run],
    ['a request', request],
    ['a run a request started', child],
  ])('reads %s', (_name, value) => {
    expect(readRunRecord(wire(value))).toEqual({ ok: true, value });
  });

  it('reads a run with no steps, and a step that has done nothing yet', () => {
    expect(readRunRecord(wire({ ...run, steps: [] })).ok).toBe(true);
    const fresh = withStep({
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      outputs: null,
      artifacts: [],
      turn: null,
      previous: [],
      output: null,
    });
    expect(readRunRecord(wire(fresh)).ok).toBe(true);
  });

  it("checks the shape alone: what a record means is the cell's check", () => {
    const odd = {
      ...run,
      id: '',
      factoryVersion: 0,
      createdAt: 'yesterday',
      automation: null,
      waitingOn: 'person',
      item: { ...run.item, url: 'http://sprocket.test' },
    };
    expect(readRunRecord(wire(odd)).ok).toBe(true);
  });

  it('keeps an output named __proto__ as an output', () => {
    // A computed key is an own key, and JSON.parse keeps it one, as a runner's JSON would.
    const read = readRunRecord(wire(withStep({ outputs: { ['__proto__']: 'x' } })));
    expect(read.ok && Object.keys(read.value.steps[0]?.outputs ?? {})).toEqual(['__proto__']);
    expect(read.ok && Object.getPrototypeOf(read.value.steps[0]?.outputs)).toBe(Object.prototype);
  });

  it('builds a value of its own, holding nothing the protocol does not name', () => {
    const sent = wire(run) as Record<string, unknown>;
    const read = readRunRecord(sent);
    expect(read.ok && read.value).not.toBe(sent);
  });

  it.each([
    ['not an object', 'run'],
    ['null', null],
    ['an array', [run]],
    ['a missing field', { ...run, updatedAt: undefined }],
    ['a field the protocol does not name', { ...run, kind: 'automation' }],
    ['an id that is not text', { ...run, id: 7 }],
    ['a version that is not a number', { ...run, factoryVersion: '3' }],
    ['an unknown status', { ...run, status: 'paused' }],
    ['an unknown trigger', { ...run, trigger: 'webhook' }],
    ['an unknown waitingOn', { ...run, waitingOn: 'gate' }],
    ['a parent with an extra field', { ...child, parent: { runId: 'r', move: 1, x: 1 } }],
    ['a parent without its move', { ...child, parent: { runId: 'r' } }],
    ['an item of an unknown kind', { ...run, item: { ...run.item, kind: 'commit' } }],
    ['an item without a title', { ...run, item: { ...run.item, title: undefined } }],
    ['an item number that is text', { ...run, item: { ...run.item, number: '12' } }],
    ['steps that are not a list', { ...run, steps: step }],
    ['too many steps', { ...run, steps: Array.from({ length: RUN_STEPS_MAX + 1 }, () => step) }],
    ['a step that is not an object', { ...run, steps: ['review'] }],
    ['a step of an unknown kind', withStep({ kind: 'gate' })],
    ['a step of an unknown status', withStep({ status: 'paused' })],
    ['a step without reminded', withStep({ reminded: undefined })],
    ['a step with an extra field', withStep({ definition: null })],
    ['a step whose reminded is text', withStep({ reminded: 'yes' })],
    ['an output that is an object', withStep({ outputs: { verdict: { x: 1 } } })],
    ['an output that is null', withStep({ outputs: { verdict: null } })],
    ['outputs that are a list', withStep({ outputs: ['approve'] })],
    [
      'too many outputs',
      withStep({
        outputs: Object.fromEntries(
          Array.from({ length: STEP_OUTPUTS_MAX + 1 }, (_, i) => [`o${i}`, i]),
        ),
      }),
    ],
    ['an artifact without its size', withStep({ artifacts: [{ name: 'handover' }] })],
    [
      'too many artifacts',
      withStep({
        artifacts: Array.from({ length: STEP_ARTIFACTS_MAX + 1 }, () => ({ name: 'a', bytes: 1 })),
      }),
    ],
    ['a turn without denied tools', withStep({ turn: { turns: 1, maxTurns: null } })],
    [
      'too many denied tools',
      withStep({
        turn: {
          turns: 1,
          maxTurns: null,
          deniedTools: Array.from({ length: STEP_DENIED_TOOLS_MAX + 1 }, () => 'Bash'),
        },
      }),
    ],
    ['a command whose truncated is missing', withStep({ command: { exitCode: 0, signal: null } })],
    [
      'an earlier attempt of an unknown status',
      withStep({ previous: [{ ...step.previous[0], status: 'x' }] }),
    ],
    [
      'too many earlier attempts',
      withStep({
        previous: Array.from({ length: STEP_PREVIOUS_MAX + 1 }, () => step.previous[0]),
      }),
    ],
    ['an output tail without stderr', withStep({ output: { stdout: '', truncated: false } })],
    [
      'a request without its text',
      { ...request, request: { ...request.request, text: undefined } },
    ],
    ['a request whose spent is null', { ...request, request: { ...request.request, spent: null } }],
    [
      'a request with an extra field',
      { ...request, request: { ...request.request, children: [] } },
    ],
    [
      'a question without its deadline',
      { ...request, request: { ...request.request, question: { at: '2026-11-25T10:00:00Z' } } },
    ],
    ['a cost that is text', { ...run, costUsd: '0.5' }],
  ])('refuses %s', (_name, value) => {
    expect(readRunRecord(wire(value)).ok).toBe(false);
  });

  it('refuses a number JSON cannot carry, sent in-process', () => {
    expect(readRunRecord({ ...run, costUsd: Number.NaN }).ok).toBe(false);
    expect(readRunRecord({ ...run, factoryVersion: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  it('names the field in a reason and never what it held', () => {
    const status = readRunRecord(wire(withStep({ status: 'hunter2-secret' })));
    expect(status).toEqual({ ok: false, reason: expect.stringContaining('run.steps[0].status') });
    expect(JSON.stringify(status)).not.toContain('hunter2');
    const extra = readRunRecord(wire({ ...run, item: { ...run.item, 'hunter2-key': 1 } }));
    expect(extra).toEqual({ ok: false, reason: expect.stringContaining('run.item') });
    const output = readRunRecord(wire(withStep({ outputs: { 'hunter2-name': { x: 1 } } })));
    expect(output).toEqual({ ok: false, reason: expect.stringContaining('run.steps[0].outputs') });
    expect(JSON.stringify(output)).not.toContain('hunter2');
  });

  it('names where the record sits in its message', () => {
    const read = readRunRecord(wire({ ...run, status: 'paused' }), 'record');
    expect(read).toEqual({ ok: false, reason: expect.stringContaining('`record.status`') });
  });
});
