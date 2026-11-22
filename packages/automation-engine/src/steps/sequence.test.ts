import { describe, expect, it } from 'vitest';
import {
  parseExpression,
  type AgentStep,
  type CommandStep,
  type GateStep,
  type Step,
  type StepRun,
  type StepRunStatus,
} from '@consola/factory-spec';
import {
  advanceSteps,
  laneOf,
  notRunAfter,
  overBudgetError,
  runSummary,
  usdWords,
  type Advance,
} from './sequence';
import { withGateAnswered, withGateAsked } from './stepRecords';

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
