import { describe, expect, it } from 'vitest';
import type { AgentRunPreview, AutomationsSnapshot, RunListEntry, RunRecord } from '../../../shared/automations';
import type { ConversationEntry } from '../../../shared/conversation';
import {
    activityCounts,
    collapseSteps,
    filterRuns,
    finalAnswer,
    formatDuration,
    modeInWords,
    ranInWords,
    runAbout,
    runStage,
    sidebarRowState,
    statusWord,
    triggerLabel,
} from './presentation';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function run(overrides: Partial<RunListEntry> = {}): RunListEntry {
    const createdAt = overrides.createdAt ?? ago(HOUR);
    return {
        id: 'r1',
        runner: 'local',
        source: 'personal',
        automationId: 'review-prs',
        actionName: 'prompt',
        actionVersion: 'v1',
        mode: 'auto',
        trigger: { kind: 'cron', at: createdAt },
        status: 'completed',
        attribution: { automationId: 'review-prs', actionName: 'prompt', triggerKind: 'cron' },
        createdAt,
        updatedAt: createdAt,
        kind: 'agent',
        ...overrides,
    };
}

function snapshot(runs: RunListEntry[], automations: AutomationsSnapshot['automations'] = []): AutomationsSnapshot {
    return {
        filePath: '/f/factory.yml',
        fileExists: true,
        automations,
        issues: [],
        runs,
        queue: {},
        suggestAssignedReviews: null,
        templates: [],
    };
}

describe('statusWord', () => {
    it('says where a run stands in a word, using the run statuses the panel shows', () => {
        expect(statusWord('needs-approval')).toBe('waiting');
        expect(statusWord('rejected')).toBe('dismissed');
        for (const status of ['queued', 'running', 'completed', 'failed'] as const) {
            expect(statusWord(status)).toBe(status);
        }
    });
});

describe('triggerLabel', () => {
    it('uses the fixed words', () => {
        expect(triggerLabel(run())).toBe('scheduled');
        expect(triggerLabel(run({ trigger: { kind: 'cron', at: '', catchUp: true } }))).toBe('catch-up');
        expect(triggerLabel(run({ trigger: { kind: 'event', at: '' } }))).toBe('event');
        expect(triggerLabel(run({ trigger: { kind: 'manual', at: '', by: 'person' } }))).toBe('run now');
        expect(triggerLabel(run({ trigger: { kind: 'manual', at: '', by: 'agent' } }))).toBe('asked by an agent');
    });
});

describe('formatDuration', () => {
    it('counts from startedAt, not createdAt', () => {
        const r = run({ createdAt: ago(HOUR), startedAt: ago(45_000), finishedAt: ago(0) });
        expect(formatDuration(r, NOW)).toBe('45s');
    });

    it('formats minutes and hours, counting to now while unfinished', () => {
        expect(formatDuration(run({ startedAt: ago(192_000) }), NOW)).toBe('3m 12s');
        expect(formatDuration(run({ startedAt: ago(HOUR + 2 * 60_000) }), NOW)).toBe('1h 02m');
    });
});

describe('runAbout', () => {
    it('prefers the item title, then the summary, then the status', () => {
        const item = { key: 'k', url: 'u', title: 'Fix the cart' };
        expect(runAbout(run({ trigger: { kind: 'event', at: '', item }, summary: 's' }))).toBe('Fix the cart');
        expect(runAbout(run({ summary: 'Removed 3 sessions' }))).toBe('Removed 3 sessions');
        expect(runAbout(run({ status: 'failed' }))).toBe('failed');
    });

    it('says why a failed run failed, in the first line of its error, over its summary', () => {
        const failed = run({
            status: 'failed',
            summary: 'Running in “Morning digest”.',
            error: 'It stopped before finishing (exit 1): Error: boom.\n    at main (cli.js:1)',
        });
        expect(runAbout(failed)).toBe('It stopped before finishing (exit 1): Error: boom.');
        // An event run is still about its item.
        const item = { key: 'k', url: 'u', title: 'Fix the cart' };
        expect(runAbout({ ...failed, trigger: { kind: 'event', at: '', item } })).toBe('Fix the cart');
        // With no error to say, the summary still does.
        expect(runAbout(run({ status: 'failed', summary: 'Did not finish in “Morning digest”.' }))).toBe(
            'Did not finish in “Morning digest”.',
        );
        // Only a failure prefers its error.
        expect(runAbout(run({ status: 'completed', summary: 'Ready.', error: 'old' }))).toBe('Ready.');
    });
});

describe('filterRuns', () => {
    it('keeps what history keeps: a run that ended in the last 30 days, and every live one; newest first', () => {
        const runs = [
            run({ id: 'old', createdAt: ago(31 * DAY) }),
            // Created long ago, but it ended within 30 days.
            run({ id: 'long', createdAt: ago(40 * DAY), updatedAt: ago(29 * DAY), finishedAt: ago(29 * DAY) }),
            // When it finished is what counts, not when it was last touched.
            run({ id: 'ended', createdAt: ago(40 * DAY), updatedAt: ago(DAY), finishedAt: ago(31 * DAY) }),
            run({ id: 'a', createdAt: ago(2 * DAY) }),
            run({ id: 'b', createdAt: ago(HOUR) }),
            // Waiting for a person or a slot, or working: never hidden, however old.
            run({ id: 'waiting', status: 'needs-approval', createdAt: ago(45 * DAY) }),
            run({ id: 'queued', status: 'queued', createdAt: ago(46 * DAY) }),
            run({ id: 'running', status: 'running', createdAt: ago(47 * DAY) }),
        ];
        expect(filterRuns(runs, '', 'all', NOW).map((r) => r.id)).toEqual(['b', 'a', 'long', 'waiting', 'queued', 'running']);
    });

    it('matches an item title case-insensitively', () => {
        const item = { key: 'k', url: 'u', title: 'Add Catalog Search' };
        const runs = [run({ id: 'x', trigger: { kind: 'event', at: '', item } }), run({ id: 'y' })];
        expect(filterRuns(runs, 'catalog search', 'all', NOW).map((r) => r.id)).toEqual(['x']);
    });

    it('matches the automation name and the summary', () => {
        const runs = [run({ id: 'x', summary: 'Removed 3 sessions' }), run({ id: 'y', automationId: 'digest' })];
        expect(filterRuns(runs, 'REMOVED', 'all', NOW).map((r) => r.id)).toEqual(['x']);
        expect(filterRuns(runs, 'digest', 'all', NOW).map((r) => r.id)).toEqual(['y']);
    });

    it('applies the kind filters: agent, tool plus requests, failed', () => {
        const runs = [
            run({ id: 'a', kind: 'agent' }),
            run({ id: 't', kind: 'tool' }),
            run({ id: 'q', kind: 'request' }),
            run({ id: 'f', kind: 'tool', status: 'failed' }),
        ];
        expect(filterRuns(runs, '', 'agent', NOW).map((r) => r.id)).toEqual(['a']);
        expect(filterRuns(runs, '', 'tool', NOW).map((r) => r.id).sort()).toEqual(['f', 'q', 't']);
        expect(filterRuns(runs, '', 'failed', NOW).map((r) => r.id)).toEqual(['f']);
    });
});

describe('activityCounts', () => {
    it('counts automations, waiting, running, queued and this week', () => {
        const auto = (name: string, onEvent: boolean) => ({ name, onEvent }) as AutomationsSnapshot['automations'][number];
        const counts = activityCounts(
            snapshot(
                [
                    run({ id: '1', status: 'needs-approval' }),
                    run({ id: '2', status: 'running' }),
                    run({ id: '3', status: 'queued' }),
                    run({ id: '4', status: 'completed', finishedAt: ago(DAY) }),
                    run({ id: '5', status: 'failed', finishedAt: ago(2 * DAY) }),
                    run({ id: '6', status: 'failed', finishedAt: ago(9 * DAY), createdAt: ago(9 * DAY) }),
                ],
                [auto('a', true), auto('b', false), auto('c', true)],
            ),
            NOW,
        );
        expect(counts).toEqual({
            automations: 3,
            onEvents: 2,
            waiting: 1,
            running: 1,
            queued: 1,
            ranThisWeek: 2,
            failedThisWeek: 1,
        });
    });
});

describe('sidebarRowState', () => {
    const lastSeen = ago(DAY);

    it('is idle without a snapshot', () => {
        expect(sidebarRowState(undefined, lastSeen)).toEqual({ kind: 'idle' });
    });

    it('ranks waiting above failed above running', () => {
        const waiting = run({ id: 'w', status: 'needs-approval' });
        const failed = run({ id: 'f', status: 'failed', finishedAt: ago(HOUR) });
        const running = run({ id: 'r', status: 'running' });
        expect(sidebarRowState(snapshot([running, failed, waiting]), lastSeen)).toEqual({ kind: 'waiting', count: 1 });
        expect(sidebarRowState(snapshot([running, failed]), lastSeen)).toEqual({ kind: 'failed', count: 1 });
        expect(sidebarRowState(snapshot([running]), lastSeen)).toEqual({ kind: 'running', count: 1 });
    });

    it('does not count a failure from before lastSeen', () => {
        const old = run({ status: 'failed', finishedAt: ago(2 * DAY) });
        expect(sidebarRowState(snapshot([old]), lastSeen)).toEqual({ kind: 'idle' });
    });

    it('counts only running agent runs', () => {
        const tool = run({ status: 'running', kind: 'tool' });
        expect(sidebarRowState(snapshot([tool]), lastSeen)).toEqual({ kind: 'idle' });
    });
});

const step = (n: number): ConversationEntry => ({ kind: 'step', tool: `Tool${n}` });
const prompt: ConversationEntry = { kind: 'prompt', text: 'Review this' };
const answerText: ConversationEntry = { kind: 'text', text: 'All good.' };

describe('collapseSteps', () => {
    it('leaves nine steps alone', () => {
        const entries = [prompt, ...Array.from({ length: 9 }, (_, i) => step(i)), answerText];
        expect(collapseSteps(entries)).toEqual(entries);
    });

    it('collapses twelve steps to 4, a "more" of 4, and 4', () => {
        const steps = Array.from({ length: 12 }, (_, i) => step(i));
        const result = collapseSteps([prompt, ...steps, answerText]);
        expect(result).toEqual([
            prompt,
            ...steps.slice(0, 4),
            { kind: 'more', count: 4, hidden: steps.slice(4, 8) },
            ...steps.slice(8),
            answerText,
        ]);
    });
});

describe('finalAnswer', () => {
    it('takes the text after the last step, joined by blank lines', () => {
        const result = finalAnswer([
            prompt,
            step(1),
            { kind: 'text', text: 'One.' },
            { kind: 'text', text: 'Two.' },
        ]);
        expect(result.answer).toBe('One.\n\nTwo.');
        expect(result.steps).toEqual([step(1)]);
    });

    it('treats texts between steps as steps', () => {
        const between: ConversationEntry = { kind: 'text', text: 'Looking now.' };
        const result = finalAnswer([prompt, step(1), between, step(2), answerText]);
        expect(result.steps).toEqual([step(1), between, step(2)]);
        expect(result.answer).toBe('All good.');
    });

    it('has no answer when the run ended on a step', () => {
        expect(finalAnswer([prompt, step(1)]).answer).toBeNull();
    });
});

describe('modeInWords', () => {
    it('says what each mode does when it fires', () => {
        expect(modeInWords('confirm')).toBe('Asks you before each run');
        expect(modeInWords('notify')).toBe('Tells you what it would do, and starts nothing');
        expect(modeInWords('auto')).toBe('Runs on its own');
        expect(modeInWords('auto', true)).toBe('Runs on its own once you approve its next run');
    });
});

const preview: AgentRunPreview = { kind: 'agent-run', runs: 'Review action', prompt: 'Review #4' };

function record(overrides: Partial<RunRecord> = {}): RunRecord {
    const { kind: _kind, ...base } = run();
    return { ...base, ...overrides };
}

describe('ranInWords', () => {
    it("names an agent run's target from its preview, and a tool by its name", () => {
        expect(ranInWords(record({ result: preview }))).toBe('Review action');
        expect(ranInWords(record({ actionName: 'consola#cleanup_stale_sessions' }))).toBe('Tool: cleanup_stale_sessions');
    });
});

describe('runStage', () => {
    it('places an agent run by where it stands', () => {
        expect(runStage(record({ result: preview, status: 'needs-approval' }))).toBe('agent-waiting');
        expect(runStage(record({ result: preview, status: 'queued' }))).toBe('agent-queued');
        expect(runStage(record({ result: preview, status: 'running' }))).toBe('agent-running');
    });

    it('has a conversation to show once a session ran it', () => {
        expect(runStage(record({ result: preview, status: 'completed', sessionId: 's1' }))).toBe('agent-finished');
        const conversation = { harnessId: 'h', id: 'c' };
        expect(runStage(record({ result: preview, status: 'failed', conversation }))).toBe('agent-finished');
    });

    it('has none when nothing started: dismissed, notify, or it could not start', () => {
        expect(runStage(record({ result: preview, status: 'rejected' }))).toBe('agent-unstarted');
        expect(runStage(record({ result: preview, status: 'completed' }))).toBe('agent-unstarted');
        expect(runStage(record({ result: preview, status: 'failed', error: 'No folder' }))).toBe('agent-unstarted');
    });

    it('treats everything else as a tool run, whatever its result', () => {
        expect(runStage(record({ status: 'needs-approval', result: { skipped: [] } }))).toBe('tool');
        expect(runStage(record({ status: 'completed' }))).toBe('tool');
    });
});
