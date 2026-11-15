import { describe, expect, it } from 'vitest';
import type { AgentRunPreview, RunRecord, StepRun, StepsRunPreview } from '../../../shared/automations';
import type { ConversationEntry } from '../../../shared/conversation';
import {
    adjacentRuns,
    durationAgainstUsual,
    foundNothingToDo,
    isInterruptedCommand,
    retryTargetOf,
    runNotes,
    runStages,
    stepBar,
    stepState,
    stepTimeline,
    toolCounts,
    workedMs,
    type RunStageState,
} from './runPage';

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

const agentRecord = (overrides: Partial<RunRecord> = {}) => record({ result: PREVIEW, actionName: 'review', ...overrides });

/** The stages as `key:state`, which is what most cases are about. */
const shape = (run: RunRecord) => runStages(run, NOW).map((stage) => `${stage.key}:${stage.state}`);
const msOf = (run: RunRecord, key: string) => runStages(run, NOW).find((stage) => stage.key === key)?.ms;

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
        expect(shape(run)).toEqual(['trigger:passed', 'preview:passed', 'approval:passed', 'run:passed']);
        expect(msOf(run, 'approval')).toBe(4 * MINUTE);
    });

    it('an older confirm tool run, without approvedAt, ends its wait at its start', () => {
        const run = record({ mode: 'confirm', approval: { args: {} }, startedAt: ago(7 * MINUTE), finishedAt: ago(7 * MINUTE) });
        expect(msOf(run, 'approval')).toBe(3 * MINUTE);
    });

    it('a run waiting for a person stands at approval, counting, with what follows still to come', () => {
        const run = record({ mode: 'confirm', status: 'needs-approval', approval: { args: {} } });
        expect(shape(run)).toEqual(['trigger:passed', 'preview:passed', 'approval:waiting', 'run:pending']);
        expect(msOf(run, 'approval')).toBe(10 * MINUTE);
        expect(msOf(run, 'run')).toBeNull();
    });

    it('a confirm run that found nothing to do ends at its preview', () => {
        const run = record({ mode: 'confirm', finishedAt: ago(10 * MINUTE - SECOND) });
        expect(foundNothingToDo(run)).toBe(true);
        expect(shape(run)).toEqual(['trigger:passed', 'preview:passed', 'approval:skipped', 'run:skipped']);
        expect(msOf(run, 'preview')).toBe(SECOND);
    });

    it('a notify run previews and tells', () => {
        expect(shape(record({ mode: 'notify' }))).toEqual(['trigger:passed', 'preview:passed', 'notify:passed']);
        expect(shape(agentRecord({ mode: 'notify' }))).toEqual(['trigger:passed', 'notify:passed']);
    });

    it('a dismissed tool run stopped at approval, and the run was never reached', () => {
        const run = record({ mode: 'confirm', status: 'rejected', approval: { args: {} }, finishedAt: ago(8 * MINUTE) });
        expect(shape(run)).toEqual(['trigger:passed', 'preview:passed', 'approval:stopped', 'run:skipped']);
        expect(msOf(run, 'approval')).toBe(2 * MINUTE);
    });

    it('a tool run refused when approved failed at approval; one whose preview threw failed there', () => {
        const refused = record({ mode: 'confirm', status: 'failed', approval: { args: {} }, error: 'Not run: x.' });
        expect(shape(refused)).toEqual(['trigger:passed', 'preview:passed', 'approval:failed', 'run:skipped']);
        const threw = record({ mode: 'confirm', status: 'failed', error: 'boom' });
        expect(shape(threw)).toEqual(['trigger:passed', 'preview:failed', 'approval:skipped', 'run:skipped']);
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
        expect([msOf(run, 'approval'), msOf(run, 'queue'), msOf(run, 'run')]).toEqual([2 * MINUTE, MINUTE, 3 * MINUTE]);
    });

    it('an older approved agent run cannot split its wait, so neither half has a length', () => {
        const run = agentRecord({ mode: 'confirm', startedAt: ago(7 * MINUTE), finishedAt: ago(4 * MINUTE) });
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
        expect(shape(agentRecord({ mode: 'confirm', status: 'rejected', approvedAt: ago(5 * MINUTE) }))).toEqual([
            'trigger:passed',
            'approval:passed',
            'queue:stopped',
            'run:skipped',
        ]);
        expect(shape(agentRecord({ status: 'rejected' }))).toEqual(['trigger:passed', 'queue:stopped', 'run:skipped']);
    });

    it('an agent run that failed before starting failed in line, or at approval when nobody approved it', () => {
        expect(shape(agentRecord({ status: 'failed' }))).toEqual(['trigger:passed', 'queue:failed', 'run:skipped']);
        const refused = agentRecord({ mode: 'confirm', status: 'failed' });
        expect(shape(refused).slice(1, 3)).toEqual(['approval:failed', 'queue:skipped']);
    });

    it('an agent run that failed after starting failed in its session', () => {
        const run = agentRecord({ status: 'failed', startedAt: ago(3 * MINUTE), finishedAt: ago(0) });
        expect(shape(run)).toEqual(['trigger:passed', 'queue:passed', 'run:failed']);
    });

    it('never has a stage both reached and unreached', () => {
        const states: RunStageState[] = runStages(record({ mode: 'confirm', status: 'needs-approval' }), NOW).map((s) => s.state);
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
        expect(runNotes(runs[0], runs)).toEqual([{ tone: 'good', text: 'Passing again after 2 failures' }]);
        const once = history(5000, 'f5000', 5000);
        expect(runNotes(once[0], once)[0].text).toBe('Passing again after a failure');
    });

    it('counts failures in a row, this one included', () => {
        const runs = history('f1', 'f1', 'f1', 5000);
        expect(runNotes(runs[0], runs)).toEqual([{ tone: 'bad', text: '3 failures in a row' }]);
    });

    it('says when a failure breaks a good run of passes, and not after only a couple', () => {
        const runs = history('f1', 5000, 5000, 5000, 5000);
        expect(runNotes(runs[0], runs)).toEqual([{ tone: 'neutral', text: 'First failure after 4 passing runs' }]);
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
        expect(runNotes(runs[1], runs)).toEqual([{ tone: 'good', text: 'Passing again after a failure' }]);
    });

    it('says nothing about a run that has not ended', () => {
        const runs = [record({ status: 'running', startedAt: ago(MINUTE) }), ...history(5000)];
        expect(runNotes(runs[0], runs)).toEqual([]);
    });
});

describe('durationAgainstUsual', () => {
    it('compares with the middle of the other runs', () => {
        const slow = history(60_000, 20_000, 30_000, 40_000);
        expect(durationAgainstUsual(slow[0], slow, NOW)).toEqual({ text: '2.0× its usual 30s', tone: 'slow' });
        const fast = history(10_000, 20_000, 30_000, 40_000);
        expect(durationAgainstUsual(fast[0], fast, NOW)).toEqual({ text: 'faster than its usual 30s', tone: 'fast' });
        const usual = history(31_000, 20_000, 30_000, 40_000);
        expect(durationAgainstUsual(usual[0], usual, NOW)).toEqual({ text: 'usual 30s', tone: 'usual' });
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
        expect(stepState(step('Bash', { endedAt: ago(0), failed: true }), false, 'completed')).toBe('failed');
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
        expect(stepBar(entry, 'passed', timeline, NOW)).toEqual({ left: 0.5, width: 0.25, ms: 25 * SECOND });
    });

    it('reaches a running step to now, and leaves an unanswered one a tick', () => {
        const running = record({ status: 'running', startedAt: started });
        const open = step('Bash', { at: ago(20 * SECOND) });
        const timeline = stepTimeline(running, [open], NOW)!;
        expect(stepBar(open, 'running', timeline, NOW)).toEqual({ left: 0.8, width: expect.closeTo(0.2), ms: 20 * SECOND });
        expect(stepBar(open, 'unknown', timeline, NOW)).toEqual({ left: 0.8, width: 0, ms: null });
    });

    it('falls back on the transcript’s own times, and has nothing to draw without any', () => {
        const unstarted = record({ status: 'failed', startedAt: undefined, finishedAt: undefined });
        const entries = [step('Read', { at: ago(30 * SECOND), endedAt: ago(10 * SECOND) })];
        expect(stepTimeline(unstarted, entries, NOW)).toEqual({ start: NOW.getTime() - 30 * SECOND, end: NOW.getTime() - 10 * SECOND });
        expect(stepTimeline(unstarted, [step('Read')], NOW)).toBeNull();
        expect(stepBar(step('Read'), 'unknown', { start: 0, end: 1 }, NOW)).toBeNull();
    });
});

const STEPS_PREVIEW: StepsRunPreview = { kind: 'steps-run', steps: [], scope: 'api' } as unknown as StepsRunPreview;

function stepOf(overrides: Partial<StepRun> & Pick<StepRun, 'id'>): StepRun {
    return { kind: 'agent', status: 'pending', attempt: 1, ...overrides };
}

const stepsRecord = (steps: StepRun[], overrides: Partial<RunRecord> = {}) =>
    record({ result: STEPS_PREVIEW, steps, ...overrides });

const stepShape = (run: RunRecord) =>
    runStages(run, NOW).map((stage) => (stage.step ? `step:${stage.step.id}:${stage.state}` : `${stage.key}:${stage.state}`));
const stepMs = (run: RunRecord, id: string) => runStages(run, NOW).find((stage) => stage.step?.id === id)?.ms;

describe('isInterruptedCommand', () => {
    const interrupted = stepOf({ id: 'publish', kind: 'run', status: 'failed', command: { envNames: [], intentAt: ago(MINUTE) } });

    it('is true for a failed command that recorded its intent and no result', () => {
        expect(isInterruptedCommand(interrupted)).toBe(true);
    });

    it('is false for an agent step, another status, no intent, or a result', () => {
        expect(isInterruptedCommand({ ...interrupted, kind: 'agent' })).toBe(false);
        expect(isInterruptedCommand({ ...interrupted, status: 'completed' })).toBe(false);
        expect(isInterruptedCommand({ ...interrupted, command: { envNames: [] } })).toBe(false);
        expect(isInterruptedCommand({ ...interrupted, command: { envNames: [], intentAt: ago(MINUTE), exitCode: 1 } })).toBe(false);
        expect(isInterruptedCommand({ ...interrupted, command: { envNames: [], intentAt: ago(MINUTE), exitCode: 0 } })).toBe(false);
        expect(isInterruptedCommand({ ...interrupted, command: { envNames: [], intentAt: ago(MINUTE), signal: 'SIGTERM' } })).toBe(false);
        expect(isInterruptedCommand({ ...interrupted, command: undefined })).toBe(false);
    });
});

describe('runStages for a steps run', () => {
    it('an asked and approved run has trigger, approval, then a node per step', () => {
        const run = stepsRecord(
            [
                stepOf({ id: 'fetch', kind: 'run', status: 'completed', queuedAt: ago(8 * MINUTE), startedAt: ago(8 * MINUTE), finishedAt: ago(7 * MINUTE) }),
                stepOf({ id: 'review', status: 'completed', queuedAt: ago(7 * MINUTE), startedAt: ago(6 * MINUTE), finishedAt: ago(4 * MINUTE) }),
            ],
            { mode: 'confirm', approvedAt: ago(9 * MINUTE), startedAt: ago(8 * MINUTE), finishedAt: ago(4 * MINUTE) },
        );
        expect(stepShape(run)).toEqual(['trigger:passed', 'approval:passed', 'step:fetch:passed', 'step:review:passed']);
        expect(msOf(run, 'approval')).toBe(MINUTE);
        expect(stepMs(run, 'fetch')).toBe(MINUTE);
        // From queuedAt, so the wait for a slot counts.
        expect(stepMs(run, 'review')).toBe(3 * MINUTE);
    });

    it('carries the step on its stage', () => {
        const run = stepsRecord([stepOf({ id: 'fetch', kind: 'run', status: 'failed', attempt: 2, error: 'boom' })], { status: 'failed' });
        expect(runStages(run, NOW)[1].step).toEqual({ id: 'fetch', kind: 'run', status: 'failed', error: 'boom', attempt: 2 });
    });

    it('a run at step 2 with step 3 pending counts the running step to now', () => {
        const run = stepsRecord(
            [
                stepOf({ id: 'a', kind: 'run', status: 'completed', startedAt: ago(5 * MINUTE), finishedAt: ago(4 * MINUTE) }),
                stepOf({ id: 'b', status: 'running', queuedAt: ago(4 * MINUTE), startedAt: ago(3 * MINUTE) }),
                stepOf({ id: 'c', status: 'pending' }),
            ],
            { status: 'running', startedAt: ago(5 * MINUTE) },
        );
        expect(stepShape(run)).toEqual(['trigger:passed', 'step:a:passed', 'step:b:running', 'step:c:pending']);
        expect([stepMs(run, 'a'), stepMs(run, 'b'), stepMs(run, 'c')]).toEqual([MINUTE, 4 * MINUTE, null]);
    });

    it('a queued step is queued, counting its wait', () => {
        const run = stepsRecord([stepOf({ id: 'a', status: 'queued', queuedAt: ago(30 * SECOND) })], { status: 'running' });
        expect(stepShape(run)).toEqual(['trigger:passed', 'step:a:queued']);
        expect(stepMs(run, 'a')).toBe(30 * SECOND);
    });

    it('a completed run with a skipped step keeps it skipped', () => {
        const run = stepsRecord(
            [
                stepOf({ id: 'a', status: 'completed', startedAt: ago(2 * MINUTE), finishedAt: ago(MINUTE) }),
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
                stepOf({ id: 'review', status: 'failed', startedAt: ago(2 * MINUTE), finishedAt: ago(MINUTE), error: 'no' }),
                stepOf({ id: 'publish', kind: 'run', status: 'not-run' }),
                stepOf({ id: 'tidy', kind: 'run', status: 'pending' }),
            ],
            { status: 'failed', finishedAt: ago(MINUTE) },
        );
        expect(stepShape(run)).toEqual(['trigger:passed', 'step:review:failed', 'step:publish:skipped', 'step:tidy:skipped']);
        expect(stepMs(run, 'review')).toBe(MINUTE);
    });

    it('a dry run draws a reported step as reported', () => {
        const run = stepsRecord(
            [
                stepOf({ id: 'review', status: 'completed', startedAt: ago(2 * MINUTE), finishedAt: ago(MINUTE) }),
                stepOf({ id: 'publish', kind: 'run', status: 'reported' }),
            ],
            { mode: 'notify', finishedAt: ago(MINUTE) },
        );
        expect(stepShape(run)).toEqual(['trigger:passed', 'step:review:passed', 'step:publish:reported']);
    });

    it('a run waiting for approval stands at approval with its steps pending', () => {
        const run = stepsRecord([stepOf({ id: 'a', status: 'pending' })], { mode: 'confirm', status: 'needs-approval' });
        expect(stepShape(run)).toEqual(['trigger:passed', 'approval:waiting', 'step:a:pending']);
        expect(msOf(run, 'approval')).toBe(10 * MINUTE);
    });

    it('a dismissed run stopped at approval', () => {
        const run = stepsRecord([stepOf({ id: 'a', status: 'pending' })], { mode: 'confirm', status: 'rejected', finishedAt: ago(8 * MINUTE) });
        expect(stepShape(run)).toEqual(['trigger:passed', 'approval:stopped', 'step:a:skipped']);
        expect(msOf(run, 'approval')).toBe(2 * MINUTE);
    });
});

describe('retryTargetOf', () => {
    it('is the failed step', () => {
        const steps = [stepOf({ id: 'a', status: 'completed' }), stepOf({ id: 'b', status: 'failed' }), stepOf({ id: 'c', status: 'not-run' })];
        expect(retryTargetOf(steps)?.id).toBe('b');
    });

    it('is the first step not run when the run ended between steps', () => {
        const steps = [stepOf({ id: 'a', status: 'completed' }), stepOf({ id: 'b', status: 'not-run' }), stepOf({ id: 'c', status: 'not-run' })];
        expect(retryTargetOf(steps)?.id).toBe('b');
    });

    it('is the first step when none ran, and nothing when every step did', () => {
        expect(retryTargetOf([stepOf({ id: 'a', status: 'not-run' }), stepOf({ id: 'b', status: 'not-run' })])?.id).toBe('a');
        expect(retryTargetOf([stepOf({ id: 'a', status: 'completed' })])).toBeUndefined();
    });
});

describe('a step status this build does not know', () => {
    it('is pending while the run is open and skipped once it ended', () => {
        const odd = stepOf({ id: 'a', status: 'paused' as StepRun['status'] });
        expect(stepShape(stepsRecord([odd], { status: 'running' }))).toEqual(['trigger:passed', 'step:a:pending']);
        expect(stepShape(stepsRecord([odd], { status: 'failed', finishedAt: ago(MINUTE) }))).toEqual(['trigger:passed', 'step:a:skipped']);
    });
});

describe('legacy runs keep their stages', () => {
    it('a run without steps has no step stages', () => {
        const stages = runStages(record(), NOW);
        expect(stages.map((stage) => stage.key)).toEqual(['trigger', 'run']);
        expect(stages.every((stage) => stage.step === undefined)).toBe(true);
    });
});
