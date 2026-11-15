import { describe, expect, it } from 'vitest';
import type { AgentStep, CommandStep, Step, StepRun, StepRunStatus } from '@consola/factory-spec';
import { STOPPED } from './commandIO';
import { advanceSteps, laneOf, notRunAfter, runSummary, type Advance } from './sequence';

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
    return { id: step.id, kind: step.kind === 'agent' ? 'agent' : 'run', status, attempt: 1, ...extra };
}
function records(steps: Step[], statuses: Record<string, StepRunStatus | StepRun>): StepRun[] {
    return steps.map((step) => {
        const given = statuses[step.id] ?? 'pending';
        return typeof given === 'string' ? record(step, given) : given;
    });
}
function advance(steps: Step[], rec: StepRun[], options: { dryRun?: boolean; item?: Record<string, string> } = {}): Advance {
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
});

describe('advanceSteps: choosing a step', () => {
    it('starts the first pending step when it has no if', () => {
        expect(advance(template, records(template, {}))).toEqual({ kind: 'start', stepId: 'fresh', lane: 'command', updates: [] });
    });

    it.each(['queued', 'running'] as const)('waits while a step is %s', (status) => {
        expect(advance(template, records(template, { fresh: 'completed', review: status }))).toEqual({ kind: 'wait' });
    });

    it('starts the agent step when its if is true', () => {
        const rec = records(template, { fresh: done(fresh, { needed: true }) });
        expect(advance(template, rec)).toEqual({ kind: 'start', stepId: 'review', lane: 'agent', updates: [] });
    });

    it('skips a step whose if is false, then moves on in the same call', () => {
        const rec = records(template, { fresh: done(fresh, { needed: false }) });
        const out = advance(template, rec);
        expect(out).toEqual({
            kind: 'complete',
            summary: 'fresh; review and publish skipped',
            updates: [
                { id: 'review', status: 'skipped', skipped: 'if: steps.fresh.needed is false' },
                { id: 'publish', status: 'skipped', skipped: 'steps.review.verdict has no value: review was skipped' },
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
        expect(advance(prOnly, records(prOnly, {}), { item: { type: 'pr' } })).toMatchObject({ kind: 'start', stepId: 'only' });
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
            updates: [{ id: 'only', status: 'failed', error: 'item.type has no value: this run has no such item field' }],
        });
    });
});

describe('advanceSteps: a dependency that did not complete', () => {
    it.each([
        ['skipped', 'skipped'],
        ['not-run', 'not run'],
        ['failed', 'failed'],
    ] as const)('an if reading a %s step is skipped without evaluating (%s)', (status, word) => {
        const steps = [{ ...fresh, id: 'a' }, { ...review, id: 'b', if: 'steps.a.needed' }];
        const rec = [record(steps[0], status), record(steps[1], 'pending')];
        // a failed step fails the run first; give the run another way to reach the reader
        const out = status === 'failed' ? advance(steps, [record(steps[0], 'skipped'), rec[1]]) : advance(steps, rec);
        const expectedWord = status === 'failed' ? 'skipped' : word;
        expect(out).toMatchObject({
            kind: 'complete',
            updates: [{ id: 'b', status: 'skipped', skipped: `steps.a.needed has no value: a was ${expectedWord}` }],
        });
    });

    it('names a step that was stopped "stopped"', () => {
        const reader: Step[] = [{ ...fresh, id: 'a', outputs: {} }, { ...review, id: 'b', if: 'steps.a.needed' }];
        const stopped = [record(reader[0], 'failed', { error: STOPPED }), record(reader[1], 'pending')];
        // pinned through noValue's wording by a producer the run no longer treats as live
        expect(advance(reader, stopped)).toMatchObject({ kind: 'fail', stepId: 'a', error: STOPPED });
    });

    it('a reads of a skipped step skips the reader', () => {
        const writer: AgentStep = { ...review, id: 'writer', if: undefined, outputs: {}, artifacts: ['notes'] };
        const reader: AgentStep = { ...review, id: 'reader', if: undefined, reads: ['writer.handover'], outputs: {} };
        const steps = [writer, reader];
        const rec = records(steps, { writer: record(writer, 'skipped', { skipped: 'x' }) });
        expect(advance(steps, rec)).toMatchObject({
            kind: 'complete',
            updates: [{ id: 'reader', status: 'skipped', skipped: 'writer.handover has no value: writer was skipped' }],
        });
    });

    it('does not evaluate an if whose dependency is missing', () => {
        const rec = records(template, { fresh: record(fresh, 'skipped') });
        const out = advance(template, rec);
        expect((out as { updates: Array<{ skipped?: string }> }).updates[0].skipped).not.toMatch(/^if:/);
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
        const rec = records(gated, { fresh: 'completed', review: done(gated[1], { verdict: 'approve' }) });
        expect(advance(gated, rec)).toMatchObject({ kind: 'start', stepId: 'publish' });
    });

    it('fails when a completed step lacks the output the template names', () => {
        const rec = records(gated, { fresh: 'completed', review: done(gated[1], {}) });
        expect(advance(gated, rec)).toMatchObject({
            kind: 'fail',
            error: 'steps.review.verdict has no value: review completed without it',
        });
    });

    it.each(['constructor', 'toString', '__proto__'])('never reads %s off Object.prototype', (name) => {
        const reader: Step = { ...publish, id: 'reader', env: { X: `{{steps.review.${name}}}` } };
        const steps = [gated[1], reader];
        const rec = records(steps, { review: done(gated[1], {}) });
        expect(advance(steps, rec)).toMatchObject({ kind: 'fail', stepId: 'reader' });
    });

    it('a step named constructor is looked up as its own', () => {
        const producer: Step = { ...fresh, id: 'constructor', outputs: { ok: { type: 'boolean' } } };
        const reader: Step = { ...publish, id: 'reader', env: { X: '{{steps.constructor.ok}}' } };
        const steps = [producer, reader];
        expect(advance(steps, [done(producer, { ok: true }), record(reader, 'pending')])).toMatchObject({ kind: 'start', stepId: 'reader' });
        expect(advance(steps, [record(producer, 'completed'), record(reader, 'pending')])).toMatchObject({ kind: 'fail' });
    });

    it('an artifact path is present when the artifact exists; .file the same', () => {
        const writer: AgentStep = { ...review, id: 'writer', if: undefined, outputs: {}, artifacts: ['notes'] };
        const reader: Step = { ...publish, id: 'reader', env: { A: '{{steps.writer.notes.file}}' } };
        const steps = [writer, reader];
        const withNotes = record(writer, 'completed', { artifacts: [{ name: 'notes', bytes: 3 }] });
        expect(advance(steps, records(steps, { writer: withNotes }))).toMatchObject({ kind: 'start', stepId: 'reader' });
        expect(advance(steps, records(steps, { writer: 'completed' }))).toMatchObject({
            kind: 'fail',
            error: 'steps.writer.notes.file has no value: writer completed without it',
        });
    });
});

describe('advanceSteps: a dry run', () => {
    const dry = (steps: Step[], statuses: Record<string, StepRunStatus | StepRun>) => advance(steps, records(steps, statuses), { dryRun: true });
    const reason = 'dry run: `publish` was not run';
    const reported = record(publish, 'reported');
    const tail = (patch: Partial<AgentStep>): AgentStep => ({ ...review, id: 'after', if: undefined, outputs: {}, ...patch });

    it.each<[string, Partial<AgentStep>]>([
        ['if', { if: 'steps.publish.done' }],
        ['reads', { reads: ['publish.handover'] }],
    ])('a step needing a reported step in %s is skipped', (_where, patch) => {
        const steps = [{ ...publish, outputs: { done: { type: 'boolean' } } } as Step, tail(patch)];
        expect(dry(steps, { publish: reported })).toMatchObject({ kind: 'complete', updates: [{ id: 'after', status: 'skipped', skipped: reason }] });
    });

    it('a command env needing a reported step is skipped', () => {
        const after: Step = { ...publish, id: 'after', env: { X: '{{steps.publish.out}}' } };
        const steps = [{ ...publish, outputs: { out: { type: 'string', maxLength: 10 } } } as Step, after];
        expect(dry(steps, { publish: reported })).toMatchObject({ updates: [{ id: 'after', status: 'skipped', skipped: reason }] });
    });

    it('a prompt needing a reported step is skipped, not failed', () => {
        const steps = [publish, tail({ prompt: 'Did {{steps.publish.out}}' })];
        expect(dry(steps, { publish: reported })).toMatchObject({ updates: [{ id: 'after', status: 'skipped', skipped: reason }] });
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
        const steps = [{ ...publish, outputs: { done: { type: 'boolean' } } } as Step, tail({ if: 'steps.publish.done' })];
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
        expect(advance(template, rec)).toEqual({ kind: 'complete', summary: 'fresh → review → publish (request-changes)', updates: [] });
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
        [['a', 'b', 'c', 'd'], { a: 'completed', b: 'skipped', c: 'skipped', d: 'skipped' }, 'a; b, c and d skipped'],
        [['a', 'b', 'c'], { a: 'completed', b: 'completed', c: 'reported' }, 'a → b; c would have run'],
        [['a', 'b', 'c'], { a: 'completed', b: 'reported', c: 'reported' }, 'a; b and c would have run'],
        [['a', 'b', 'c', 'd'], { a: 'completed', b: 'reported', c: 'skipped', d: 'reported' }, 'a; b and d would have run; c skipped'],
    ] as const)('%j %j', (ids, statuses, expected) => {
        expect(names([...ids], statuses as Record<string, StepRunStatus>)).toBe(expected);
    });

    it('puts only enum values in the parentheses, in step order', () => {
        const a: Step = { ...fresh, id: 'a', outputs: { flag: { type: 'boolean' }, kind: { type: 'enum', values: ['x', 'y'] } } };
        const b: Step = { ...review, id: 'b', if: undefined };
        const rec = [record(a, 'completed', { outputs: { flag: true, kind: 'y' } }), record(b, 'completed', { outputs: { verdict: 'approve' } })];
        expect(runSummary([a, b], rec)).toBe('a → b (y, approve)');
    });
});
