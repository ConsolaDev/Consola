import { describe, expect, it } from 'vitest';
import type { AgentRunPreview, RunRecord } from '../../../shared/automations';
import type { ConversationEntry } from '../../../shared/conversation';
import {
    adjacentRuns,
    durationAgainstUsual,
    foundNothingToDo,
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
