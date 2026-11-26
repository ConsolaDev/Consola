import { describe, expect, it } from 'vitest';
import { parseExpression } from '@consola/factory-spec';
import type {
  AgentStep,
  CommandStep,
  GateStep,
  OnExhausted,
  RepeatStep,
  Step,
  StepEntry,
  StepRun,
  StepRunStatus,
  UsesStep,
} from '@consola/factory-spec';
import {
  advanceSteps,
  laneOf,
  notRunAfter,
  overBudgetError,
  runSummary,
  usdWords,
} from './sequence';
import type { Advance } from './sequence';
import { stepRecordsOf, withGateAnswered, withGateAsked, withRound, withStep } from './stepRecords';

const fresh: CommandStep = {
  kind: 'run',
  id: 'fresh',
  named: true,
  run: 'gh pr view',
  env: {},
  outputs: { needed: { type: 'boolean' } },
  timeoutMs: 600_000,
  dryRun: 'run',
};
const review: AgentStep = {
  kind: 'agent',
  id: 'review',
  named: true,
  if: 'steps.fresh.needed',
  prompt: 'Review {{item.title}}',
  outputs: { verdict: { type: 'enum', values: ['approve', 'comment', 'request-changes'] } },
  artifacts: [],
  reads: [],
  handover: 'optional',
};
const publish: CommandStep = {
  kind: 'run',
  id: 'publish',
  named: true,
  run: 'gh pr review',
  env: { VERDICT: '{{steps.review.verdict}}' },
  outputs: {},
  timeoutMs: 600_000,
  dryRun: 'report',
};
/** The review template's publish: posts only when the review asks for changes. */
const gatedPublish: CommandStep = { ...publish, if: "steps.review.verdict == 'request-changes'" };
const template: Step[] = [fresh, review, gatedPublish];

function record(step: Step, status: StepRunStatus, extra: Partial<StepRun> = {}): StepRun {
  return {
    id: step.id,
    kind: step.kind === 'agent' ? 'agent' : 'run',
    status,
    attempt: 1,
    ...extra,
  };
}
function records(steps: Step[], statuses: Record<string, StepRunStatus | StepRun>): StepRun[] {
  return steps.map((step) => {
    const given = statuses[step.id] ?? 'pending';
    return typeof given === 'string' ? record(step, given) : given;
  });
}
function advance(
  steps: Step[],
  rec: StepRun[],
  options: { dryRun?: boolean; item?: Record<string, string> } = {},
): Advance {
  return advanceSteps({
    steps,
    records: rec,
    dryRun: options.dryRun ?? false,
    itemValue: (field) => (options.item ?? { title: 'Fix the cart total' })[field],
  });
}
const done = (step: Step, outputs: StepRun['outputs']) => record(step, 'completed', { outputs });

describe('laneOf', () => {
  it.each([
    [fresh, 'command'],
    [review, 'agent'],
  ] as const)('%s', (step, lane) => expect(laneOf(step)).toBe(lane));

  it('is never asked of a gate, which takes no slot: asking is loud', () => {
    const gate: GateStep = { kind: 'gate', id: 'decide', named: true, ask: 'Post it?', show: [] };
    expect(() => laneOf(gate)).toThrow('a gate has no lane');
  });
});

describe('a gate in the sequence', () => {
  const decide: GateStep = {
    kind: 'gate',
    id: 'decide',
    named: true,
    ask: 'Post it as {{steps.review.verdict}}?',
    show: [],
  };
  const gateRecord = (status: StepRunStatus, extra: Partial<StepRun> = {}): StepRun => ({
    id: 'decide',
    kind: 'gate',
    status,
    attempt: 1,
    ...extra,
  });

  it("waits on what its question templates: a skipped producer fails it, as a prompt's would", () => {
    const steps: Step[] = [review, decide];
    expect(
      advanceSteps({
        steps,
        records: [record(review, 'skipped', { skipped: 'if: x is false' }), gateRecord('pending')],
        dryRun: false,
      }),
    ).toEqual({
      kind: 'fail',
      stepId: 'decide',
      error: 'steps.review.verdict has no value: review was skipped',
      updates: [
        {
          id: 'decide',
          status: 'failed',
          error: 'steps.review.verdict has no value: review was skipped',
        },
      ],
    });
  });

  it("puts a gate's decision among the verdicts, as an enum output's value (review M5)", () => {
    const steps: Step[] = [review, decide];
    expect(
      runSummary(steps, [
        done(review, { verdict: 'approve' }),
        gateRecord('completed', { outputs: { decision: 'comment' } }),
      ]),
    ).toBe('review → decide (approve, comment)');
  });
});

describe('advanceSteps: choosing a step', () => {
  it('starts the first pending step when it has no if', () => {
    expect(advance(template, records(template, {}))).toEqual({
      kind: 'start',
      stepId: 'fresh',
      lane: 'command',
      updates: [],
    });
  });

  it.each(['queued', 'running'] as const)('waits while a step is %s', (status) => {
    expect(advance(template, records(template, { fresh: 'completed', review: status }))).toEqual({
      kind: 'wait',
    });
  });

  it('starts the agent step when its if is true', () => {
    const rec = records(template, { fresh: done(fresh, { needed: true }) });
    expect(advance(template, rec)).toEqual({
      kind: 'start',
      stepId: 'review',
      lane: 'agent',
      updates: [],
    });
  });

  it('skips a step whose if is false, then moves on in the same call', () => {
    const rec = records(template, { fresh: done(fresh, { needed: false }) });
    const out = advance(template, rec);
    expect(out).toEqual({
      kind: 'complete',
      summary: 'fresh; review and publish skipped',
      updates: [
        { id: 'review', status: 'skipped', skipped: 'if: steps.fresh.needed is false' },
        {
          id: 'publish',
          status: 'skipped',
          skipped: 'steps.review.verdict has no value: review was skipped',
        },
      ],
    });
  });

  it('starts the next step with the skip updates that came before it', () => {
    const solo: Step[] = [
      fresh,
      { ...review, if: 'steps.fresh.needed' },
      { ...fresh, id: 'tidy', outputs: {} },
    ];
    const rec = records(solo, { fresh: done(fresh, { needed: false }) });
    expect(advance(solo, rec)).toEqual({
      kind: 'start',
      stepId: 'tidy',
      lane: 'command',
      updates: [{ id: 'review', status: 'skipped', skipped: 'if: steps.fresh.needed is false' }],
    });
  });

  it('evaluates an item field through itemValue', () => {
    const prOnly: Step[] = [{ ...fresh, id: 'only', if: "item.type == 'pr'", outputs: {} }];
    expect(advance(prOnly, records(prOnly, {}), { item: { type: 'pr' } })).toMatchObject({
      kind: 'start',
      stepId: 'only',
    });
    expect(advance(prOnly, records(prOnly, {}), { item: { type: 'issue' } })).toMatchObject({
      kind: 'complete',
      updates: [{ id: 'only', status: 'skipped', skipped: "if: item.type == 'pr' is false" }],
    });
  });

  it('fails a step whose if names an item field with no value', () => {
    const prOnly: Step[] = [{ ...fresh, id: 'only', if: "item.type == 'pr'", outputs: {} }];
    expect(advance(prOnly, records(prOnly, {}), { item: {} })).toEqual({
      kind: 'fail',
      stepId: 'only',
      error: 'item.type has no value: this run has no such item field',
      updates: [
        {
          id: 'only',
          status: 'failed',
          error: 'item.type has no value: this run has no such item field',
        },
      ],
    });
  });
});

describe('advanceSteps: an untyped item (a poll’s fields)', () => {
  const polled = { draft: true, head: 'abc', count: 3 } as Record<
    string,
    string | number | boolean
  >;
  const onItem = (condition: string): Step[] => [
    { ...fresh, id: 'only', if: condition, outputs: {} },
    { ...fresh, id: 'after', outputs: {} },
  ];
  const advanceOn = (
    steps: Step[],
    untypedItem: boolean | undefined,
    item: Record<string, string | number | boolean> = polled,
  ) =>
    advanceSteps({
      steps,
      records: records(steps, {}),
      dryRun: false,
      itemValue: (field) => item[field],
      ...(untypedItem === undefined ? {} : { untypedItem }),
    });

  it('with an untyped item, an absent field in if: skips the step', () => {
    expect(advanceOn(onItem("item.state == 'open'"), true)).toEqual({
      kind: 'start',
      stepId: 'after',
      lane: 'command',
      updates: [{ id: 'only', status: 'skipped', skipped: 'if: item.state is absent' }],
    });
    // Every field it names must be there, as for a step output: the other side of an || does not rescue it.
    expect(advanceOn(onItem("item.head == 'abc' || item.state == 'open'"), true)).toMatchObject({
      updates: [{ id: 'only', skipped: 'if: item.state is absent' }],
    });
  });

  it('with an untyped item, a field of another type skips it', () => {
    expect(advanceOn(onItem("item.draft == 'yes'"), true)).toEqual({
      kind: 'start',
      stepId: 'after',
      lane: 'command',
      updates: [
        { id: 'only', status: 'skipped', skipped: 'if: item.draft is true or false, not a string' },
      ],
    });
    expect(advanceOn(onItem('item.head > 2'), true)).toMatchObject({
      updates: [{ id: 'only', skipped: 'if: item.head is a string, not a number' }],
    });
    expect(advanceOn(onItem('1 == item.count || item.count == false'), true)).toMatchObject({
      updates: [{ id: 'only', skipped: 'if: item.count is a number, not true or false' }],
    });
  });

  it('with an untyped item, fields of the literal’s type are compared as usual', () => {
    expect(
      advanceOn(onItem("item.head == 'abc' && item.count >= 3 && !(item.draft == false)"), true),
    ).toMatchObject({
      kind: 'start',
      stepId: 'only',
      updates: [],
    });
    expect(advanceOn(onItem("item.head != 'abc'"), true)).toMatchObject({
      updates: [{ id: 'only', skipped: "if: item.head != 'abc' is false" }],
    });
  });

  it('a typed item still fails on an absent field', () => {
    const prOnly: Step[] = [{ ...fresh, id: 'only', if: "item.type == 'pr'", outputs: {} }];
    for (const untypedItem of [false, undefined]) {
      expect(advanceOn(prOnly, untypedItem, {})).toEqual({
        kind: 'fail',
        stepId: 'only',
        error: 'item.type has no value: this run has no such item field',
        updates: [
          {
            id: 'only',
            status: 'failed',
            error: 'item.type has no value: this run has no such item field',
          },
        ],
      });
    }
  });
});

describe('advanceSteps: a dependency that did not complete', () => {
  it.each([
    ['skipped', 'skipped'],
    ['not-run', 'not run'],
  ] as const)('an if reading a %s step is skipped without evaluating (%s)', (status, word) => {
    const steps = [
      { ...fresh, id: 'a' },
      { ...review, id: 'b', if: 'steps.a.needed' },
    ];
    const out = advance(steps, [record(steps[0], status), record(steps[1], 'pending')]);
    expect(out).toMatchObject({
      kind: 'complete',
      updates: [
        { id: 'b', status: 'skipped', skipped: `steps.a.needed has no value: a was ${word}` },
      ],
    });
  });

  it('fails a step whose if cannot be read, and marks later steps not-run', () => {
    const steps: Step[] = [
      { ...fresh, id: 'a', outputs: {}, if: 'steps.x &&' },
      { ...fresh, id: 'b', outputs: {} },
    ];
    const parsed = parseExpression('steps.x &&');
    const problem = parsed.ok ? '' : parsed.problem;
    const error = `if: steps.x && could not be read: ${problem}`;
    expect(problem).not.toBe('');
    expect(advance(steps, records(steps, {}))).toEqual({
      kind: 'fail',
      stepId: 'a',
      error,
      updates: [
        { id: 'a', status: 'failed', error },
        { id: 'b', status: 'not-run' },
      ],
    });
  });

  it('a reads of a skipped step skips the reader', () => {
    const writer: AgentStep = {
      ...review,
      id: 'writer',
      if: undefined,
      outputs: {},
      artifacts: ['notes'],
    };
    const reader: AgentStep = {
      ...review,
      id: 'reader',
      if: undefined,
      reads: ['writer.handover'],
      outputs: {},
    };
    const steps = [writer, reader];
    const rec = records(steps, { writer: record(writer, 'skipped', { skipped: 'x' }) });
    expect(advance(steps, rec)).toMatchObject({
      kind: 'complete',
      updates: [
        {
          id: 'reader',
          status: 'skipped',
          skipped: 'writer.handover has no value: writer was skipped',
        },
      ],
    });
  });

  it('does not evaluate an if whose dependency is missing', () => {
    const rec = records(template, { fresh: record(fresh, 'skipped') });
    const out = advance(template, rec);
    expect((out as { updates: Array<{ skipped?: string }> }).updates[0].skipped).not.toMatch(
      /^if:/,
    );
  });
});

describe('advanceSteps: templates', () => {
  const gated: Step[] = [
    { ...fresh, outputs: {} },
    { ...review, if: undefined, id: 'review' },
    publish,
  ];

  it.each([
    ['skipped', 'review was skipped'],
    ['not-run', 'review was not run'],
  ] as const)('an env value of a %s step fails the step and the run', (status, why) => {
    const rec = records(gated, { fresh: 'completed', review: record(gated[1], status) });
    const error = `steps.review.verdict has no value: ${why}`;
    expect(advance(gated, rec)).toEqual({
      kind: 'fail',
      stepId: 'publish',
      error,
      updates: [{ id: 'publish', status: 'failed', error }],
    });
  });

  it('fails an agent step whose prompt needs an absent value, and marks later steps not-run', () => {
    const steps: Step[] = [
      { ...fresh, outputs: {} },
      { ...review, id: 'first', if: undefined, outputs: { verdict: review.outputs.verdict } },
      { ...review, id: 'second', if: undefined, prompt: 'After {{steps.first.verdict}}' },
      { ...fresh, id: 'last', outputs: {} },
    ];
    const rec = records(steps, { fresh: 'completed', first: record(steps[1], 'skipped') });
    const error = 'steps.first.verdict has no value: first was skipped';
    expect(advance(steps, rec)).toEqual({
      kind: 'fail',
      stepId: 'second',
      error,
      updates: [
        { id: 'second', status: 'failed', error },
        { id: 'last', status: 'not-run' },
      ],
    });
  });

  it('fills a prompt from a completed step', () => {
    const rec = records(gated, {
      fresh: 'completed',
      review: done(gated[1], { verdict: 'approve' }),
    });
    expect(advance(gated, rec)).toMatchObject({ kind: 'start', stepId: 'publish' });
  });

  it('fails when a completed step lacks the output the template names', () => {
    const rec = records(gated, { fresh: 'completed', review: done(gated[1], {}) });
    expect(advance(gated, rec)).toMatchObject({
      kind: 'fail',
      error: 'steps.review.verdict has no value: review completed without it',
    });
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'never reads %s off Object.prototype',
    (name) => {
      const reader: Step = { ...publish, id: 'reader', env: { X: `{{steps.review.${name}}}` } };
      const steps = [gated[1], reader];
      const rec = records(steps, { review: done(gated[1], {}) });
      expect(advance(steps, rec)).toMatchObject({ kind: 'fail', stepId: 'reader' });
    },
  );

  it('a step named constructor is looked up as its own', () => {
    const producer: Step = { ...fresh, id: 'constructor', outputs: { ok: { type: 'boolean' } } };
    const reader: Step = { ...publish, id: 'reader', env: { X: '{{steps.constructor.ok}}' } };
    const steps = [producer, reader];
    expect(advance(steps, [done(producer, { ok: true }), record(reader, 'pending')])).toMatchObject(
      { kind: 'start', stepId: 'reader' },
    );
    expect(
      advance(steps, [record(producer, 'completed'), record(reader, 'pending')]),
    ).toMatchObject({ kind: 'fail' });
  });

  it('an artifact path is present when the artifact exists; .file the same', () => {
    const writer: AgentStep = {
      ...review,
      id: 'writer',
      if: undefined,
      outputs: {},
      artifacts: ['notes'],
    };
    const reader: Step = { ...publish, id: 'reader', env: { A: '{{steps.writer.notes.file}}' } };
    const steps = [writer, reader];
    const withNotes = record(writer, 'completed', { artifacts: [{ name: 'notes', bytes: 3 }] });
    expect(advance(steps, records(steps, { writer: withNotes }))).toMatchObject({
      kind: 'start',
      stepId: 'reader',
    });
    expect(advance(steps, records(steps, { writer: 'completed' }))).toMatchObject({
      kind: 'fail',
      error: 'steps.writer.notes.file has no value: writer completed without it',
    });
  });
});

describe('advanceSteps: previous', () => {
  it('a step that reads only previous starts with no previous run', () => {
    // The step reads its own handover from the last run: nothing in this run can be missing for it.
    const rereview: AgentStep = {
      ...review,
      if: undefined,
      reads: ['previous.review.handover'],
      outputs: {},
    };
    expect(advance([rereview], records([rereview], {}))).toEqual({
      kind: 'start',
      stepId: 'review',
      lane: 'agent',
      updates: [],
    });
    // Nor does a later step's, nor a step of this run that was skipped.
    const writer: AgentStep = { ...review, id: 'writer', if: undefined, outputs: {} };
    const reader: AgentStep = {
      ...review,
      id: 'reader',
      if: undefined,
      reads: ['previous.writer.handover', 'previous.later.handover'],
      outputs: {},
    };
    const later: AgentStep = { ...review, id: 'later', if: undefined, outputs: {} };
    const steps = [writer, reader, later];
    expect(advance(steps, records(steps, { writer: 'skipped' }))).toEqual({
      kind: 'start',
      stepId: 'reader',
      lane: 'agent',
      updates: [],
    });
  });

  it('previous in env is never a dependency', () => {
    const rereview: AgentStep = { ...review, if: undefined, outputs: {} };
    const reader: Step = {
      ...publish,
      env: { LAST: '{{previous.review.handover}}', LAST_FILE: '{{previous.review.handover.file}}' },
    };
    // This run's `review` was skipped, and a later step reads the last run's: it starts.
    const steps = [rereview, reader];
    expect(advance(steps, records(steps, { review: 'skipped' }))).toEqual({
      kind: 'start',
      stepId: 'publish',
      lane: 'command',
      updates: [],
    });
    // Before the step it names has run in this run, the same.
    const first = [reader, rereview];
    expect(advance(first, records(first, {}))).toEqual({
      kind: 'start',
      stepId: 'publish',
      lane: 'command',
      updates: [],
    });
  });
});

describe('advanceSteps: a dry run', () => {
  const dry = (steps: Step[], statuses: Record<string, StepRunStatus | StepRun>) =>
    advance(steps, records(steps, statuses), { dryRun: true });
  const reason = 'dry run: `publish` was not run';
  const reported = record(publish, 'reported');
  const tail = (patch: Partial<AgentStep>): AgentStep => ({
    ...review,
    id: 'after',
    if: undefined,
    outputs: {},
    ...patch,
  });

  it.each<[string, Partial<AgentStep>]>([
    ['if', { if: 'steps.publish.done' }],
    ['reads', { reads: ['publish.handover'] }],
  ])('a step needing a reported step in %s is skipped', (_where, patch) => {
    const steps = [{ ...publish, outputs: { done: { type: 'boolean' } } } as Step, tail(patch)];
    expect(dry(steps, { publish: reported })).toMatchObject({
      kind: 'complete',
      updates: [{ id: 'after', status: 'skipped', skipped: reason }],
    });
  });

  it('a command env needing a reported step is skipped', () => {
    const after: Step = { ...publish, id: 'after', env: { X: '{{steps.publish.out}}' } };
    const steps = [
      { ...publish, outputs: { out: { type: 'string', maxLength: 10 } } } as Step,
      after,
    ];
    expect(dry(steps, { publish: reported })).toMatchObject({
      updates: [{ id: 'after', status: 'skipped', skipped: reason }],
    });
  });

  it('a prompt needing a reported step is skipped, not failed', () => {
    const steps = [publish, tail({ prompt: 'Did {{steps.publish.out}}' })];
    expect(dry(steps, { publish: reported })).toMatchObject({
      updates: [{ id: 'after', status: 'skipped', skipped: reason }],
    });
  });

  it('is transitive: a step needing a dry-run skip is skipped for the same reason', () => {
    const second: AgentStep = tail({ id: 'second', if: 'steps.publish.done' });
    const third: AgentStep = tail({ id: 'third', if: 'steps.second.verdict' });
    const steps: Step[] = [{ ...publish, outputs: { done: { type: 'boolean' } } }, second, third];
    expect(dry(steps, { publish: reported })).toMatchObject({
      updates: [
        { id: 'second', status: 'skipped', skipped: reason },
        { id: 'third', status: 'skipped', skipped: 'dry run: `second` was not run' },
      ],
    });
  });

  it('outside a dry run the same reading is an ordinary skip', () => {
    const steps = [
      { ...publish, outputs: { done: { type: 'boolean' } } } as Step,
      tail({ if: 'steps.publish.done' }),
    ];
    expect(advance(steps, records(steps, { publish: reported }))).toMatchObject({
      updates: [{ id: 'after', skipped: 'steps.publish.done has no value: publish was not run' }],
    });
  });
});

describe('advanceSteps: settling', () => {
  it('completes with the summary when everything settled', () => {
    const rec = records(template, {
      fresh: done(fresh, { needed: true }),
      review: done(review, { verdict: 'request-changes' }),
      publish: 'completed',
    });
    expect(advance(template, rec)).toEqual({
      kind: 'complete',
      summary: 'fresh → review → publish (request-changes)',
      updates: [],
    });
  });

  it('completes a dry run, naming what would have run', () => {
    const rec = records(template, {
      fresh: done(fresh, { needed: true }),
      review: done(review, { verdict: 'comment' }),
      publish: 'reported',
    });
    expect(advance(template, rec, { dryRun: true })).toMatchObject({
      kind: 'complete',
      summary: 'fresh → review (comment); publish would have run',
    });
  });

  it('fails, rather than completes, when a step failed and nothing is active', () => {
    const rec = records(template, { fresh: record(fresh, 'failed', { error: 'exit 2' }) });
    expect(advance(template, rec)).toEqual({
      kind: 'fail',
      stepId: 'fresh',
      error: 'exit 2',
      updates: [
        { id: 'review', status: 'not-run' },
        { id: 'publish', status: 'not-run' },
      ],
    });
  });
});

describe('notRunAfter', () => {
  it('marks only the later steps that have not settled', () => {
    const rec = records(template, { fresh: 'failed', review: 'queued', publish: 'pending' });
    expect(notRunAfter(template, rec, 'fresh')).toEqual([
      { id: 'review', status: 'not-run' },
      { id: 'publish', status: 'not-run' },
    ]);
    const settled = records(template, { fresh: 'failed', review: 'skipped', publish: 'pending' });
    expect(notRunAfter(template, settled, 'fresh')).toEqual([{ id: 'publish', status: 'not-run' }]);
    expect(notRunAfter(template, settled, 'publish')).toEqual([]);
    expect(notRunAfter(template, settled, 'nope')).toEqual([]);
  });
});

describe('runSummary', () => {
  const solo = (id: string): Step => ({ ...fresh, id, outputs: {} });
  const names = (ids: string[], statuses: Record<string, StepRunStatus>) => {
    const steps = ids.map(solo);
    return runSummary(steps, records(steps, statuses));
  };

  it.each([
    [['a'], { a: 'skipped' }, 'a skipped'],
    [['a', 'b'], { a: 'completed', b: 'skipped' }, 'a; b skipped'],
    [['a', 'b', 'c'], { a: 'completed', b: 'skipped', c: 'skipped' }, 'a; b and c skipped'],
    [
      ['a', 'b', 'c', 'd'],
      { a: 'completed', b: 'skipped', c: 'skipped', d: 'skipped' },
      'a; b, c and d skipped',
    ],
    [['a', 'b', 'c'], { a: 'completed', b: 'completed', c: 'reported' }, 'a → b; c would have run'],
    [
      ['a', 'b', 'c'],
      { a: 'completed', b: 'reported', c: 'reported' },
      'a; b and c would have run',
    ],
    [
      ['a', 'b', 'c', 'd'],
      { a: 'completed', b: 'reported', c: 'skipped', d: 'reported' },
      'a; b and d would have run; c skipped',
    ],
  ] as const)('%j %j', (ids, statuses, expected) => {
    expect(names([...ids], statuses as Record<string, StepRunStatus>)).toBe(expected);
  });

  it('puts only enum values in the parentheses, in step order', () => {
    const a: Step = {
      ...fresh,
      id: 'a',
      outputs: { flag: { type: 'boolean' }, kind: { type: 'enum', values: ['x', 'y'] } },
    };
    const b: Step = { ...review, id: 'b', if: undefined };
    const rec = [
      record(a, 'completed', { outputs: { flag: true, kind: 'y' } }),
      record(b, 'completed', { outputs: { verdict: 'approve' } }),
    ];
    expect(runSummary([a, b], rec)).toBe('a → b (y, approve)');
  });

  it('names a step that ran in an earlier round among those that ran, not as skipped (3-A code review M11)', () => {
    // Round 2 was clean: `address` skipped there, after it ran in round 1.
    const records = round(2, { review: { findings: 0 } }, { address: 'skipped' }).map((row) =>
      row.id === 'polish' ? { ...row, status: 'completed' as const } : row,
    );
    expect(runSummary(POLISH_ENTRY, records)).toBe('review → address');
    // Skipped in every round: still skipped.
    const never = records.map((row) =>
      row.id === 'address'
        ? {
            ...row,
            previous: row.previous?.map((line) => ({ ...line, status: 'skipped' as const })),
          }
        : row,
    );
    expect(runSummary(POLISH_ENTRY, never)).toBe('review; address skipped');
  });
});

// --- slice 3: gates, then: stop and the budget (Task 7) ------------------------

/** The spec's gated review: a check, a review, a gate on an approval, then one post or the other. */
const decideGate: GateStep = {
  kind: 'gate',
  id: 'decide',
  named: true,
  if: "steps.review.verdict == 'approve'",
  ask: 'The reviewer would approve this pull request. Post the review as an approval?',
  show: ['review.handover'],
};
const publishDecided: CommandStep = {
  ...publish,
  id: 'publish-decided',
  if: "steps.decide.decision == 'approve'",
  env: { DECISION: '{{steps.decide.decision}}' },
};
const publishOther: CommandStep = { ...publish, if: "steps.review.verdict != 'approve'" };
const GATED: Step[] = [fresh, review, decideGate, publishDecided, publishOther];

/** The spec's §4.1 head: triage, a step that ends the run for what is not ours, then the fix. */
const triage: AgentStep = {
  ...review,
  id: 'triage',
  if: undefined,
  prompt: 'Triage it.',
  outputs: { kind: { type: 'enum', values: ['bug', 'feature'] } },
};
const notOurs: CommandStep = {
  ...publish,
  id: 'not-ours',
  if: "steps.triage.kind == 'feature'",
  env: {},
  stop: true,
};
const fix: AgentStep = { ...review, id: 'fix', if: undefined, prompt: 'Fix it.', outputs: {} };
const TRIAGE: Step[] = [triage, notOurs, fix];

/** Records of `steps`, those named in `ids` completed (with `outputs` by id; `fresh` needed), the rest pending. */
function doneRows(
  steps: Step[],
  ids: string[],
  outputs: Record<string, StepRun['outputs']> = {},
): StepRun[] {
  return steps.map((step) => ({
    id: step.id,
    kind: step.kind,
    status: ids.includes(step.id) ? 'completed' : 'pending',
    attempt: 1,
    ...(ids.includes(step.id)
      ? { outputs: outputs[step.id] ?? (step.id === 'fresh' ? { needed: true } : {}) }
      : {}),
  }));
}
const T0 = '2026-11-22T09:00:00.000Z';

describe('advanceSteps: gates', () => {
  it('parks at a gate whose if: holds', () => {
    expect(
      advanceSteps({
        steps: GATED,
        records: doneRows(GATED, ['fresh', 'review'], { review: { verdict: 'approve' } }),
        dryRun: false,
      }),
    ).toEqual({ kind: 'ask', stepId: 'decide', updates: [] });
  });

  it('skips a gate whose if: is false, and the step reading its decision', () => {
    const next = advanceSteps({
      steps: GATED,
      records: doneRows(GATED, ['fresh', 'review'], { review: { verdict: 'comment' } }),
      dryRun: false,
    });
    expect(next).toMatchObject({ kind: 'start', stepId: 'publish' });
    expect(next.kind === 'wait' ? [] : next.updates).toEqual([
      {
        id: 'decide',
        status: 'skipped',
        skipped: "if: steps.review.verdict == 'approve' is false",
      },
      {
        id: 'publish-decided',
        status: 'skipped',
        skipped: 'steps.decide.decision has no value: decide was skipped',
      },
    ]);
  });

  it('waits while a gate waits', () => {
    const records = withGateAsked(
      doneRows(GATED, ['fresh', 'review'], { review: { verdict: 'approve' } }),
      'decide',
      T0,
    );
    expect(advanceSteps({ steps: GATED, records, dryRun: false })).toEqual({ kind: 'wait' });
  });

  it('goes on once the gate is answered, by its decision', () => {
    const asked = withGateAsked(
      doneRows(GATED, ['fresh', 'review'], { review: { verdict: 'approve' } }),
      'decide',
      T0,
    );
    const answered = withGateAnswered(asked, 'decide', { decision: 'approve', nowIso: T0 });
    expect(advanceSteps({ steps: GATED, records: answered, dryRun: false })).toMatchObject({
      kind: 'start',
      stepId: 'publish-decided',
      updates: [],
    });
  });

  it('reports a gate in a dry run and skips what reads its decision', () => {
    const next = advanceSteps({
      steps: GATED,
      records: doneRows(GATED, ['fresh', 'review'], { review: { verdict: 'approve' } }),
      dryRun: true,
    });
    expect(next.kind === 'wait' ? [] : next.updates).toContainEqual({
      id: 'decide',
      status: 'reported',
      note: 'Would have asked: The reviewer would approve this pull request. Post the review as an approval?',
    });
    expect(next.kind === 'wait' ? [] : next.updates).toContainEqual(
      expect.objectContaining({
        id: 'publish-decided',
        status: 'skipped',
        skipped: 'dry run: `decide` was not run',
      }),
    );
    // The walk goes on past it: `publish` is skipped by its own `if:`, and the dry run completes.
    expect(next).toMatchObject({
      kind: 'complete',
      summary:
        'fresh → review (approve); decide would have run; publish-decided and publish skipped',
    });
  });

  it('reports a gate in a dry run with its question as written, templates and all', () => {
    const templated: GateStep = {
      ...decideGate,
      ask: 'Post #{{item.number}} as {{steps.review.verdict}}?',
    };
    const next = advanceSteps({
      steps: [fresh, review, templated],
      records: doneRows([fresh, review, templated], ['fresh', 'review'], {
        review: { verdict: 'approve' },
      }),
      dryRun: true,
      itemValue: (field) => (field === 'number' ? 51 : undefined),
    });
    expect(next.kind === 'wait' ? [] : next.updates).toEqual([
      {
        id: 'decide',
        status: 'reported',
        note: 'Would have asked: Post #{{item.number}} as {{steps.review.verdict}}?',
      },
    ]);
  });
});

describe("advanceSteps: a loop's own row", () => {
  it('never waits for it: only its steps are work under way', () => {
    const look: AgentStep = { ...review, id: 'look', if: undefined, prompt: 'Look.', outputs: {} };
    const steps = [
      {
        kind: 'repeat' as const,
        id: 'polish',
        named: true as const,
        max: 2,
        until: 'steps.look.done',
        steps: [look],
      },
    ];
    const records: StepRun[] = [
      { id: 'polish', kind: 'repeat', status: 'running', attempt: 1, round: 1, max: 2 },
      { id: 'look', kind: 'agent', status: 'pending', attempt: 1, round: 1 },
    ];
    expect(advanceSteps({ steps, records, dryRun: false })).toMatchObject({
      kind: 'start',
      stepId: 'look',
    });
    expect(
      advanceSteps({
        steps,
        records: records.map((row) =>
          row.id === 'look' ? { ...row, status: 'running' as const } : row,
        ),
        dryRun: false,
      }),
    ).toEqual({ kind: 'wait' });
  });
});

describe('advanceSteps: then: stop', () => {
  it('then: stop ends the run completed after its step, the rest not-run', () => {
    const next = advanceSteps({
      steps: TRIAGE,
      records: doneRows(TRIAGE, ['triage', 'not-ours'], { triage: { kind: 'feature' } }),
      dryRun: false,
    });
    expect(next).toEqual({
      kind: 'complete',
      summary: 'triage → not-ours (feature); stopped after not-ours',
      updates: [{ id: 'fix', status: 'not-run', note: 'the run stopped after `not-ours`' }],
    });
  });

  it('a skipped step with then: stop stops nothing', () => {
    const records = doneRows(TRIAGE, ['triage'], { triage: { kind: 'bug' } });
    expect(advanceSteps({ steps: TRIAGE, records, dryRun: false })).toEqual({
      kind: 'start',
      stepId: 'fix',
      lane: 'agent',
      updates: [
        {
          id: 'not-ours',
          status: 'skipped',
          skipped: "if: steps.triage.kind == 'feature' is false",
        },
      ],
    });
  });

  it('a failed step with then: stop stops nothing: the run fails at it', () => {
    const records = doneRows(TRIAGE, ['triage'], { triage: { kind: 'feature' } }).map((row) =>
      row.id === 'not-ours' ? { ...row, status: 'failed' as const, error: 'exit 1' } : row,
    );
    expect(advanceSteps({ steps: TRIAGE, records, dryRun: false })).toEqual({
      kind: 'fail',
      stepId: 'not-ours',
      error: 'exit 1',
      updates: [{ id: 'fix', status: 'not-run' }],
    });
  });

  it('a stop with nothing left after it completes as usual', () => {
    const steps: Step[] = [triage, { ...notOurs, if: undefined }];
    expect(
      advanceSteps({
        steps,
        records: doneRows(steps, ['triage', 'not-ours'], { triage: { kind: 'feature' } }),
        dryRun: false,
      }),
    ).toEqual({ kind: 'complete', summary: 'triage → not-ours (feature)', updates: [] });
  });

  it('a gate answered with then: stop ends the run after it', () => {
    const stopping: GateStep = { ...decideGate, stop: true };
    const steps: Step[] = [fresh, review, stopping, publishDecided];
    const answered = withGateAnswered(
      withGateAsked(
        doneRows(steps, ['fresh', 'review'], { review: { verdict: 'approve' } }),
        'decide',
        T0,
      ),
      'decide',
      { decision: 'approve', nowIso: T0 },
    );
    expect(advanceSteps({ steps, records: answered, dryRun: false })).toEqual({
      kind: 'complete',
      summary: 'fresh → review → decide (approve, approve); stopped after decide',
      updates: [
        { id: 'publish-decided', status: 'not-run', note: 'the run stopped after `decide`' },
      ],
    });
  });
});

describe('advanceSteps: the budget', () => {
  it('fails at the boundary once the run spent its budget', () => {
    // `triage`'s kind is given (review S5): without it `not-ours`, whose `if:` reads it, would skip, and the failure land at `fix`.
    expect(
      advanceSteps({
        steps: TRIAGE,
        records: doneRows(TRIAGE, ['triage'], { triage: { kind: 'feature' } }),
        dryRun: false,
        budget: { usd: 5, spent: 5.03 },
      }),
    ).toEqual({
      kind: 'fail',
      stepId: 'not-ours',
      error: 'over its budget: $5.03 spent of $5.00',
      overBudget: true,
      updates: [
        { id: 'not-ours', status: 'failed', error: 'over its budget: $5.03 spent of $5.00' },
        { id: 'fix', status: 'not-run' },
      ],
    });
    expect(
      advanceSteps({
        steps: TRIAGE,
        records: doneRows(TRIAGE, ['triage'], { triage: { kind: 'feature' } }),
        dryRun: false,
        budget: { usd: 5, spent: 4.99 },
      }),
    ).toMatchObject({ kind: 'start', stepId: 'not-ours' });
  });

  it('fails exactly at the budget, after the skips that came before it', () => {
    const next = advanceSteps({
      steps: TRIAGE,
      records: doneRows(TRIAGE, ['triage'], { triage: { kind: 'bug' } }),
      dryRun: false,
      budget: { usd: 5, spent: 5 },
    });
    expect(next).toMatchObject({ kind: 'fail', stepId: 'fix', overBudget: true });
    expect(next.kind === 'wait' ? [] : next.updates[0]).toEqual({
      id: 'not-ours',
      status: 'skipped',
      skipped: "if: steps.triage.kind == 'feature' is false",
    });
  });

  it('fails over budget before a gate too', () => {
    expect(
      advanceSteps({
        steps: GATED,
        records: doneRows(GATED, ['fresh', 'review'], { review: { verdict: 'approve' } }),
        dryRun: false,
        budget: { usd: 1, spent: 2 },
      }),
    ).toMatchObject({
      kind: 'fail',
      stepId: 'decide',
      overBudget: true,
      error: 'over its budget: $2.00 spent of $1.00',
    });
  });

  it('still completes a run with nothing left to start, and reports a gate in a dry run over it', () => {
    const rows = doneRows(TRIAGE, ['triage', 'not-ours', 'fix'], { triage: { kind: 'feature' } });
    expect(
      advanceSteps({
        steps: [triage, { ...notOurs, stop: undefined }, fix],
        records: rows,
        dryRun: false,
        budget: { usd: 1, spent: 9 },
      }),
    ).toMatchObject({ kind: 'complete' });
    const dry = advanceSteps({
      steps: [fresh, review, decideGate],
      records: doneRows([fresh, review, decideGate], ['fresh', 'review'], {
        review: { verdict: 'approve' },
      }),
      dryRun: true,
      budget: { usd: 1, spent: 9 },
    });
    expect(dry).toMatchObject({ kind: 'complete' });
  });

  it('has no ceiling without one', () => {
    expect(
      advanceSteps({
        steps: TRIAGE,
        records: doneRows(TRIAGE, ['triage'], { triage: { kind: 'feature' } }),
        dryRun: false,
      }),
    ).toMatchObject({ kind: 'start', stepId: 'not-ours' });
  });

  it('words dollars', () => {
    expect(usdWords(5)).toBe('$5.00');
    expect(usdWords(5.03)).toBe('$5.03');
    expect(usdWords(0.0246)).toBe('$0.0246');
    expect(usdWords(1000)).toBe('$1000.00');
    expect(overBudgetError(1.2, 1)).toBe('over its budget: $1.20 spent of $1.00');
  });
});

describe('runSummary, with gates', () => {
  it("sums up a gated run with the gate's decision among the verdicts (review M5)", () => {
    expect(
      runSummary(
        GATED,
        doneRows(GATED, ['fresh', 'review', 'decide', 'publish-decided'], {
          review: { verdict: 'approve' },
          decide: { decision: 'approve' },
        }),
      ),
    ).toBe('fresh → review → decide → publish-decided (approve, approve)');
  });

  it('names a reported gate among what would have run', () => {
    const rows = doneRows(GATED, ['fresh', 'review'], { review: { verdict: 'approve' } }).map(
      (row) => (row.id === 'decide' ? { ...row, status: 'reported' as const } : row),
    );
    expect(runSummary(GATED, rows)).toBe('fresh → review (approve); decide would have run');
  });
});

// --- slice 3: loops (Task 8) ----------------------------------------------------

const reviewRound: AgentStep = {
  ...review,
  if: undefined,
  prompt: 'Review it.',
  outputs: { findings: { type: 'integer' } },
};
const address: AgentStep = {
  ...review,
  id: 'address',
  if: 'steps.review.findings > 0',
  prompt: 'Address it.',
  outputs: { fixed: { type: 'boolean' } },
};
/** `polish`: up to three rounds of `review` then `address`, until no findings are left. */
const POLISH: RepeatStep = {
  kind: 'repeat',
  id: 'polish',
  named: true,
  max: 3,
  until: 'steps.review.findings == 0',
  steps: [reviewRound, address],
};
const pr: CommandStep = { ...publish, id: 'pr', env: {} };
const POLISH_ENTRY: StepEntry[] = [POLISH, pr];

/** POLISH_ENTRY with `polish` changed. */
const withLoop = (patch: Partial<RepeatStep>, after: Step[] = [pr]): StepEntry[] => [
  { ...POLISH, ...patch },
  ...after,
];
const withExhausted = (onExhausted: OnExhausted | undefined): StepEntry[] =>
  withLoop(onExhausted === undefined ? {} : { onExhausted });

/**
 * POLISH_ENTRY's records after `k` rounds: each round's steps completed (or as `statuses` says, in round
 * `k`), round `k`'s outputs as `outputs` says, and its loop row still `running`, as the sequencer finds it.
 */
function round(
  k: number,
  outputs: Record<string, StepRun['outputs']> = {},
  statuses: Record<string, StepRunStatus> = {},
  entries: StepEntry[] = POLISH_ENTRY,
): StepRun[] {
  const block = entries.find((entry): entry is RepeatStep => entry.kind === 'repeat')!;
  let rows = stepRecordsOf(entries);
  for (const id of entries.filter((entry) => entry.kind !== 'repeat').map((entry) => entry.id)) {
    if (entries.findIndex((entry) => entry.id === id) < entries.indexOf(block)) {
      rows = withStep(rows, id, { status: 'completed', outputs: outputs[id] ?? {} });
    }
  }
  for (let at = 1; at <= k; at++) {
    rows = withRound(rows, block, at, T0);
    for (const inner of block.steps) {
      const last = at === k;
      rows = withStep(rows, inner.id, {
        status: (last ? statuses[inner.id] : undefined) ?? 'completed',
        outputs: last ? (outputs[inner.id] ?? {}) : { findings: 1 },
      });
    }
  }
  return rows;
}
const updatesOf = (next: Advance) => (next.kind === 'wait' ? [] : next.updates);

describe('advanceSteps: loops', () => {
  it('starts round 1, then the first inner step', () => {
    expect(
      advanceSteps({ steps: POLISH_ENTRY, records: stepRecordsOf(POLISH_ENTRY), dryRun: false }),
    ).toEqual({ kind: 'round', blockId: 'polish', round: 1, updates: [] });
    expect(
      advanceSteps({
        steps: POLISH_ENTRY,
        records: withRound(stepRecordsOf(POLISH_ENTRY), POLISH, 1, T0),
        dryRun: false,
      }),
    ).toMatchObject({ kind: 'start', stepId: 'review', lane: 'agent' });
  });

  it('is clean after round 1 when until holds, and goes on', () => {
    const next = advanceSteps({
      steps: POLISH_ENTRY,
      records: round(1, { review: { findings: 0 } }, { address: 'skipped' }),
      dryRun: false,
    });
    expect(next).toMatchObject({ kind: 'start', stepId: 'pr' });
    expect(updatesOf(next)).toEqual([
      { id: 'polish', status: 'completed', note: 'clean after round 1' },
    ]);
  });

  it('runs a round in order: a skipped inner step, then until', () => {
    const records = withStep(withRound(stepRecordsOf(POLISH_ENTRY), POLISH, 1, T0), 'review', {
      status: 'completed',
      outputs: { findings: 0 },
    });
    const next = advanceSteps({ steps: POLISH_ENTRY, records, dryRun: false });
    expect(next).toMatchObject({ kind: 'start', stepId: 'pr' });
    expect(updatesOf(next)).toEqual([
      { id: 'address', status: 'skipped', skipped: 'if: steps.review.findings > 0 is false' },
      { id: 'polish', status: 'completed', note: 'clean after round 1' },
    ]);
  });

  it('starts round 2 when until does not hold', () => {
    expect(
      advanceSteps({
        steps: POLISH_ENTRY,
        records: round(1, { review: { findings: 1 } }),
        dryRun: false,
      }),
    ).toEqual({ kind: 'round', blockId: 'polish', round: 2, updates: [] });
  });

  it('is clean after round 3, its last, when until holds then (review M10)', () => {
    const next = advanceSteps({
      steps: POLISH_ENTRY,
      records: round(3, { review: { findings: 0 } }, { address: 'skipped' }),
      dryRun: false,
    });
    expect(next).toMatchObject({ kind: 'start', stepId: 'pr' });
    expect(updatesOf(next)).toEqual([
      { id: 'polish', status: 'completed', note: 'clean after round 3' },
    ]);
  });

  it('reads a skipped until path as not met', () => {
    const entries = withLoop({ until: 'steps.address.fixed == true' });
    const records = round(1, { review: { findings: 0 } }, { address: 'skipped' }, entries);
    expect(advanceSteps({ steps: entries, records, dryRun: false })).toEqual({
      kind: 'round',
      blockId: 'polish',
      round: 2,
      updates: [],
    });
  });

  it.each<[OnExhausted | undefined, Partial<Advance>]>([
    [undefined, { kind: 'fail', stepId: 'polish', error: 'polish: not clean after 3 rounds' }],
    ['fail', { kind: 'fail', stepId: 'polish', error: 'polish: not clean after 3 rounds' }],
    ['continue', { kind: 'start', stepId: 'pr' }],
    [
      { ask: 'Open it anyway?', show: [] },
      { kind: 'ask', stepId: 'polish' },
    ],
  ])('on_exhausted %j after round 3', (onExhausted, expected) => {
    expect(
      advanceSteps({
        steps: withExhausted(onExhausted),
        records: round(3, { review: { findings: 2 } }, {}, withExhausted(onExhausted)),
        dryRun: false,
      }),
    ).toMatchObject(expected);
  });

  it("words each exhaustion's updates", () => {
    const failed = advanceSteps({
      steps: POLISH_ENTRY,
      records: round(3, { review: { findings: 2 } }),
      dryRun: false,
    });
    expect(updatesOf(failed)).toEqual([
      { id: 'polish', status: 'failed', error: 'polish: not clean after 3 rounds' },
      { id: 'pr', status: 'not-run' },
    ]);
    const going = advanceSteps({
      steps: withExhausted('continue'),
      records: round(3, { review: { findings: 2 } }, {}, withExhausted('continue')),
      dryRun: false,
    });
    expect(updatesOf(going)).toEqual([
      { id: 'polish', status: 'completed', note: 'stopped after 3 rounds' },
    ]);
    const asking = advanceSteps({
      steps: withExhausted({ ask: 'Open it anyway?', show: [] }),
      records: round(
        3,
        { review: { findings: 2 } },
        {},
        withExhausted({ ask: 'Open it anyway?', show: [] }),
      ),
      dryRun: false,
    });
    expect(asking).toEqual({ kind: 'ask', stepId: 'polish', updates: [] });
  });

  it('runs a fourth round only when a retry gave it one, and is exhausted again after it', () => {
    const records = round(4, { review: { findings: 2 } });
    expect(advanceSteps({ steps: POLISH_ENTRY, records, dryRun: false })).toMatchObject({
      kind: 'fail',
      stepId: 'polish',
      error: 'polish: not clean after 4 rounds',
    });
  });

  it('skips the whole loop when its if: is false', () => {
    const entries: StepEntry[] = [
      { ...triage },
      { ...POLISH, if: "steps.triage.kind == 'bug'" },
      pr,
    ];
    const records = withStep(stepRecordsOf(entries), 'triage', {
      status: 'completed',
      outputs: { kind: 'feature' },
    });
    const next = advanceSteps({ steps: entries, records, dryRun: false });
    expect(next).toMatchObject({ kind: 'start', stepId: 'pr' });
    expect(updatesOf(next)).toEqual([
      { id: 'polish', status: 'skipped', skipped: "if: steps.triage.kind == 'bug' is false" },
      { id: 'review', status: 'skipped', skipped: 'the loop `polish` was skipped' },
      { id: 'address', status: 'skipped', skipped: 'the loop `polish` was skipped' },
    ]);
  });

  it('starts the loop when its if: holds, and skips it when what its if: reads was skipped', () => {
    const entries: StepEntry[] = [
      { ...triage },
      { ...POLISH, if: "steps.triage.kind == 'bug'" },
      pr,
    ];
    const bug = withStep(stepRecordsOf(entries), 'triage', {
      status: 'completed',
      outputs: { kind: 'bug' },
    });
    expect(advanceSteps({ steps: entries, records: bug, dryRun: false })).toEqual({
      kind: 'round',
      blockId: 'polish',
      round: 1,
      updates: [],
    });
    const skipped = withStep(stepRecordsOf(entries), 'triage', { status: 'skipped', skipped: 'x' });
    expect(updatesOf(advanceSteps({ steps: entries, records: skipped, dryRun: false }))[0]).toEqual(
      {
        id: 'polish',
        status: 'skipped',
        skipped: 'steps.triage.kind has no value: triage was skipped',
      },
    );
  });

  it('a later step reads the latest round', () => {
    const entries = withLoop({}, [{ ...pr, if: 'steps.review.findings == 0' }]);
    const records = round(2, { review: { findings: 0 } }, { address: 'skipped' }, entries);
    expect(advanceSteps({ steps: entries, records, dryRun: false })).toMatchObject({
      kind: 'start',
      stepId: 'pr',
    });
  });

  it('passes over a loop that ended, whatever way it ended', () => {
    for (const status of ['completed', 'skipped', 'reported'] as const) {
      const records = withStep(round(2, { review: { findings: 1 } }), 'polish', { status });
      expect(advanceSteps({ steps: POLISH_ENTRY, records, dryRun: false })).toMatchObject({
        kind: 'start',
        stepId: 'pr',
      });
    }
  });

  it('reports an exhaustion gate in a dry run and goes on after the block', () => {
    const entries = withExhausted({ ask: 'Open it anyway?', show: [] });
    const next = advanceSteps({
      steps: entries,
      records: round(3, { review: { findings: 2 } }, {}, entries),
      dryRun: true,
    });
    expect(next).toMatchObject({ kind: 'start', stepId: 'pr' });
    expect(updatesOf(next)).toEqual([
      {
        id: 'polish',
        status: 'reported',
        note: 'Would have asked after 3 rounds: Open it anyway?',
      },
    ]);
  });

  it('ends a dry run loop whose until waits on a reported command (Call 10)', () => {
    const check: CommandStep = {
      ...publish,
      id: 'check',
      env: {},
      outputs: { clean: { type: 'boolean' } },
    };
    const entries = withLoop({ until: 'steps.check.clean == true', steps: [reviewRound, check] });
    const records = withStep(
      withStep(withRound(stepRecordsOf(entries), entries[0] as RepeatStep, 1, T0), 'review', {
        status: 'completed',
        outputs: { findings: 1 },
      }),
      'check',
      { status: 'reported' },
    );
    const next = advanceSteps({ steps: entries, records, dryRun: true });
    expect(next).toMatchObject({ kind: 'start', stepId: 'pr' });
    expect(updatesOf(next)).toEqual([
      {
        id: 'polish',
        status: 'reported',
        note: 'a real run would repeat until steps.check.clean == true',
      },
    ]);
    // Outside a dry run the same record is no value: round 2.
    expect(advanceSteps({ steps: entries, records, dryRun: false })).toMatchObject({
      kind: 'round',
      round: 2,
    });
  });

  it('runs a dry run loop on, round after round, while until has its values and is not met', () => {
    expect(
      advanceSteps({
        steps: POLISH_ENTRY,
        records: round(1, { review: { findings: 1 } }),
        dryRun: true,
      }),
    ).toMatchObject({ kind: 'round', round: 2 });
  });

  it('fails the run and its loop when an inner step fails', () => {
    const records = withStep(round(2, { review: { findings: 1 } }), 'address', {
      status: 'failed',
      error: 'exit 1',
    });
    expect(advanceSteps({ steps: POLISH_ENTRY, records, dryRun: false })).toEqual({
      kind: 'fail',
      stepId: 'address',
      error: 'exit 1',
      updates: [
        { id: 'polish', status: 'failed' },
        { id: 'pr', status: 'not-run' },
      ],
    });
  });

  it('names the failed step, not its loop row, once both failed, and fails the row no second time', () => {
    const records = withStep(
      withStep(round(2, { review: { findings: 1 } }), 'address', {
        status: 'failed',
        error: 'exit 1',
      }),
      'polish',
      { status: 'failed' },
    );
    expect(advanceSteps({ steps: POLISH_ENTRY, records, dryRun: false })).toEqual({
      kind: 'fail',
      stepId: 'address',
      error: 'exit 1',
      updates: [{ id: 'pr', status: 'not-run' }],
    });
  });

  it('runs a dry run loop on when what until waits on was skipped by its own if:, not left unrun', () => {
    const entries = withLoop({ until: 'steps.address.fixed == true' });
    const records = round(1, { review: { findings: 0 } }, { address: 'skipped' }, entries);
    expect(advanceSteps({ steps: entries, records, dryRun: true })).toMatchObject({
      kind: 'round',
      round: 2,
    });
  });

  it('fails the loop with a step that cannot start inside it', () => {
    const lacking: AgentStep = {
      ...address,
      if: undefined,
      prompt: 'Fix {{steps.review.handover}}',
    };
    const entries = withLoop({ steps: [reviewRound, lacking] });
    const records = withStep(
      withRound(stepRecordsOf(entries), entries[0] as RepeatStep, 1, T0),
      'review',
      {
        status: 'completed',
        outputs: { findings: 1 },
      },
    );
    expect(advanceSteps({ steps: entries, records, dryRun: false })).toEqual({
      kind: 'fail',
      stepId: 'address',
      error: 'steps.review.handover has no value: review completed without it',
      updates: [
        {
          id: 'address',
          status: 'failed',
          error: 'steps.review.handover has no value: review completed without it',
        },
        { id: 'polish', status: 'failed' },
        { id: 'pr', status: 'not-run' },
      ],
    });
  });

  it('checks the budget before a round', () => {
    expect(
      advanceSteps({
        steps: POLISH_ENTRY,
        records: round(1, { review: { findings: 1 } }),
        dryRun: false,
        budget: { usd: 1, spent: 1.2 },
      }),
    ).toEqual({
      kind: 'fail',
      stepId: 'polish',
      error: 'over its budget: $1.20 spent of $1.00',
      overBudget: true,
      updates: [
        { id: 'polish', status: 'failed', error: 'over its budget: $1.20 spent of $1.00' },
        { id: 'pr', status: 'not-run' },
      ],
    });
    // Before round 1, and before an exhaustion gate, too.
    expect(
      advanceSteps({
        steps: POLISH_ENTRY,
        records: stepRecordsOf(POLISH_ENTRY),
        dryRun: false,
        budget: { usd: 1, spent: 1 },
      }),
    ).toMatchObject({ kind: 'fail', stepId: 'polish', overBudget: true });
    const asking = withExhausted({ ask: 'Open it anyway?', show: [] });
    expect(
      advanceSteps({
        steps: asking,
        records: round(3, { review: { findings: 2 } }, {}, asking),
        dryRun: false,
        budget: { usd: 1, spent: 1 },
      }),
    ).toMatchObject({ kind: 'fail', stepId: 'polish', overBudget: true });
  });

  it('stops the loop with then: stop inside it', () => {
    const entries = withLoop({ steps: [reviewRound, { ...address, stop: true }] });
    const records = round(1, { review: { findings: 1 } }, {}, entries);
    expect(advanceSteps({ steps: entries, records, dryRun: false })).toEqual({
      kind: 'complete',
      summary: 'review → address; stopped after address',
      updates: [
        { id: 'polish', status: 'completed', note: 'the run stopped after `address` in round 1' },
        { id: 'pr', status: 'not-run', note: 'the run stopped after `address`' },
      ],
    });
  });

  it('stops a loop that ends the entry, when then: stop is on its last step (review B1)', () => {
    const entries = withLoop({ steps: [reviewRound, { ...address, stop: true }] }, []);
    const records = round(1, { review: { findings: 1 } }, {}, entries);
    // Nothing follows the stopping step in record order: the loop's own row comes before it.
    expect(advanceSteps({ steps: entries, records, dryRun: false })).toEqual({
      kind: 'complete',
      summary: 'review → address; stopped after address',
      updates: [
        { id: 'polish', status: 'completed', note: 'the run stopped after `address` in round 1' },
      ],
    });
    // Round 2's stop as well: never a round 3.
    const second = round(2, { review: { findings: 1 } }, {}, entries);
    expect(advanceSteps({ steps: entries, records: second, dryRun: false })).toMatchObject({
      kind: 'complete',
      updates: [
        { id: 'polish', status: 'completed', note: 'the run stopped after `address` in round 2' },
      ],
    });
  });

  it('a stop on the last step of a loop that already closed stops nothing more', () => {
    const entries = withLoop({ steps: [reviewRound, { ...address, stop: true }] }, []);
    const records = round(1, { review: { findings: 1 } }, {}, entries).map((row) =>
      row.id === 'polish'
        ? { ...row, status: 'completed' as const, note: 'clean after round 1' }
        : row,
    );
    expect(advanceSteps({ steps: entries, records, dryRun: false })).toEqual({
      kind: 'complete',
      summary: 'review → address',
      updates: [],
    });
  });

  it('stops the rest of its round too', () => {
    const entries = withLoop({ steps: [{ ...reviewRound, stop: true }, address] });
    const records = withStep(
      withRound(stepRecordsOf(entries), entries[0] as RepeatStep, 2, T0),
      'review',
      {
        status: 'completed',
        outputs: { findings: 1 },
      },
    );
    expect(updatesOf(advanceSteps({ steps: entries, records, dryRun: false }))).toEqual([
      { id: 'polish', status: 'completed', note: 'the run stopped after `review` in round 2' },
      { id: 'address', status: 'not-run', note: 'the run stopped after `review`' },
      { id: 'pr', status: 'not-run', note: 'the run stopped after `review`' },
    ]);
  });

  it('parks at a gate inside a loop as at any gate', () => {
    const ask: GateStep = { kind: 'gate', id: 'ask-first', named: true, ask: 'Go on?', show: [] };
    const entries = withLoop({ steps: [ask, reviewRound] });
    expect(
      advanceSteps({
        steps: entries,
        records: withRound(stepRecordsOf(entries), entries[0] as RepeatStep, 1, T0),
        dryRun: false,
      }),
    ).toEqual({ kind: 'ask', stepId: 'ask-first', updates: [] });
  });

  it("reads the run's item in until, and an item field with no value is not met", () => {
    const entries = withLoop({ until: 'item.number > 50' });
    const records = round(1, { review: { findings: 1 } }, {}, entries);
    expect(
      advanceSteps({
        steps: entries,
        records,
        dryRun: false,
        itemValue: (field) => (field === 'number' ? 51 : undefined),
      }),
    ).toMatchObject({ kind: 'start', stepId: 'pr' });
    expect(
      advanceSteps({ steps: entries, records, dryRun: false, itemValue: () => undefined }),
    ).toMatchObject({
      kind: 'round',
      round: 2,
    });
  });

  it('fails at a loop whose until cannot be read, which only a hand-built entry has', () => {
    const entries = withLoop({ until: 'steps.review.findings ==' });
    expect(
      advanceSteps({
        steps: entries,
        records: round(1, { review: { findings: 1 } }, {}, entries),
        dryRun: false,
      }),
    ).toMatchObject({
      kind: 'fail',
      stepId: 'polish',
      error: expect.stringMatching(/^until: steps\.review\.findings == could not be read: /),
    });
  });

  it('marks what a failed loop row did not reach, and the steps after it, not-run', () => {
    expect(notRunAfter(POLISH_ENTRY, stepRecordsOf(POLISH_ENTRY), 'polish')).toEqual([
      { id: 'review', status: 'not-run' },
      { id: 'address', status: 'not-run' },
      { id: 'pr', status: 'not-run' },
    ]);
  });
});

describe('advanceSteps: a call whose with: lacks a value (5a-2 Task 7, Call 15)', () => {
  const a: CommandStep = {
    ...fresh,
    id: 'a',
    outputs: { note: { type: 'string', maxLength: 100 } },
  };
  const call = (withArgs: Record<string, unknown>): UsesStep => ({
    kind: 'uses',
    id: 'post',
    named: true,
    uses: 'slack#chat_post_message',
    server: 'slack',
    tool: 'chat_post_message',
    with: withArgs,
    outputs: {},
    timeoutMs: 60_000,
    dryRun: 'report',
  });
  const tail: CommandStep = { ...fresh, id: 'tail', outputs: {} };

  it('skips it, naming the path, and the run goes on', () => {
    const steps: Step[] = [a, call({ text: 'Note: {{steps.a.note}}' }), tail];
    expect(advance(steps, records(steps, { a: 'skipped' }))).toEqual({
      kind: 'start',
      stepId: 'tail',
      lane: 'command',
      updates: [
        {
          id: 'post',
          status: 'skipped',
          skipped: 'with: steps.a.note has no value: a was skipped',
        },
      ],
    });
  });

  it('skips it as a dry run left its producer unrun', () => {
    const steps: Step[] = [a, call({ text: '{{steps.a.note}}' })];
    expect(advance(steps, records(steps, { a: 'reported' }), { dryRun: true })).toMatchObject({
      kind: 'complete',
      updates: [{ id: 'post', status: 'skipped', skipped: 'dry run: `a` was not run' }],
    });
  });

  it('skips it on an item that lacks a field, where a command naming one fails', () => {
    const steps: Step[] = [call({ ts: '{{item.nope}}' })];
    expect(
      advanceSteps({
        steps,
        records: records(steps, {}),
        dryRun: false,
        itemValue: () => undefined,
        untypedItem: true,
      }),
    ).toMatchObject({
      kind: 'complete',
      updates: [
        {
          id: 'post',
          status: 'skipped',
          skipped: 'with: item.nope has no value: this run has no such item field',
        },
      ],
    });
    const command: CommandStep = { ...fresh, env: { TS: '{{item.nope}}' } };
    expect(
      advanceSteps({
        steps: [command],
        records: records([command], {}),
        dryRun: false,
        itemValue: () => undefined,
        untypedItem: true,
      }),
    ).toMatchObject({
      kind: 'fail',
      error: 'item.nope has no value: this run has no such item field',
    });
  });

  it('starts it in the command lane', () => {
    expect(laneOf(call({}))).toBe('command');
  });
});
