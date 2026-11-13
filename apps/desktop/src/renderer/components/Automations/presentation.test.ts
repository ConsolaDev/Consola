import { describe, expect, it } from 'vitest';
import type { AgentRunPreview, AutomationsSnapshot, RunListEntry, RunRecord } from '../../../shared/automations';
import type { ConversationEntry } from '../../../shared/conversation';
import {
    activityCounts,
    collapseSteps,
    filterRuns,
    finalAnswer,
    formatAgo,
    formatCountdown,
    formatDueAt,
    formatDuration,
    formatRunWhen,
    historySlots,
    isRunFilterNarrowed,
    latestRun,
    modeInWords,
    NO_RUN_FILTER,
    ranInWords,
    recentRuns,
    recentRunsInWords,
    runAbout,
    runAutomationOptions,
    runStage,
    sidebarRowState,
    statusWord,
    triggerLabel,
    type RunListFilter,
} from './presentation';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const by = (filter: Partial<RunListFilter> = {}): RunListFilter => ({ ...NO_RUN_FILTER, ...filter });

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
        expect(filterRuns(runs, by(), NOW).map((r) => r.id)).toEqual(['b', 'a', 'long', 'waiting', 'queued', 'running']);
    });

    it('matches an item title case-insensitively', () => {
        const item = { key: 'k', url: 'u', title: 'Add Catalog Search' };
        const runs = [run({ id: 'x', trigger: { kind: 'event', at: '', item } }), run({ id: 'y' })];
        expect(filterRuns(runs, by({ query: 'catalog search' }), NOW).map((r) => r.id)).toEqual(['x']);
    });

    it('matches the automation name and the summary', () => {
        const runs = [run({ id: 'x', summary: 'Removed 3 sessions' }), run({ id: 'y', automationId: 'digest' })];
        expect(filterRuns(runs, by({ query: 'REMOVED' }), NOW).map((r) => r.id)).toEqual(['x']);
        expect(filterRuns(runs, by({ query: 'digest' }), NOW).map((r) => r.id)).toEqual(['y']);
    });

    it('applies the kind filters: agent, tool plus requests, failed', () => {
        const runs = [
            run({ id: 'a', kind: 'agent' }),
            run({ id: 't', kind: 'tool' }),
            run({ id: 'q', kind: 'request' }),
            run({ id: 'f', kind: 'tool', status: 'failed' }),
        ];
        expect(filterRuns(runs, by({ kind: 'agent' }), NOW).map((r) => r.id)).toEqual(['a']);
        expect(filterRuns(runs, by({ kind: 'tool' }), NOW).map((r) => r.id).sort()).toEqual(['f', 'q', 't']);
        expect(filterRuns(runs, by({ kind: 'failed' }), NOW).map((r) => r.id)).toEqual(['f']);
    });

    it('narrows to one automation by its id, exactly, and combines with the other filters', () => {
        const runs = [
            run({ id: 'r', automationId: 'review-prs' }),
            run({ id: 'r2', automationId: 'review-prs-nightly' }),
            run({ id: 'rf', automationId: 'review-prs', status: 'failed' }),
            run({ id: 'd', automationId: 'digest' }),
        ];
        expect(filterRuns(runs, by({ automation: 'review-prs' }), NOW).map((r) => r.id).sort()).toEqual(['r', 'rf']);
        expect(filterRuns(runs, by({ automation: 'review-prs', kind: 'failed' }), NOW).map((r) => r.id)).toEqual(['rf']);
        expect(filterRuns(runs, by({ automation: 'digest', query: 'review' }), NOW)).toEqual([]);
    });
});

describe('isRunFilterNarrowed', () => {
    it('is false only for no query (blank counts as none), every kind and every automation', () => {
        expect(isRunFilterNarrowed(by({ query: '   ' }))).toBe(false);
        expect(isRunFilterNarrowed(by({ query: 'x' }))).toBe(true);
        expect(isRunFilterNarrowed(by({ kind: 'failed' }))).toBe(true);
        expect(isRunFilterNarrowed(by({ automation: 'digest' }))).toBe(true);
    });
});

describe('runAutomationOptions', () => {
    const auto = (name: string) => ({ name }) as AutomationsSnapshot['automations'][number];

    it("lists the file's entries in order, then what else has runs, each with its count", () => {
        const history = [
            run({ id: '1', automationId: 'digest' }),
            run({ id: '2', automationId: 'digest' }),
            run({ id: '3', automationId: 'removed-one' }),
            run({ id: '4', automationId: 'consola#delete_session', source: 'manual', actionName: 'consola#delete_session' }),
        ];
        const options = runAutomationOptions(snapshot([], [auto('sweep'), auto('digest')]), history, null);
        expect(options).toEqual([
            { id: 'sweep', label: 'sweep', count: 0, inFile: true },
            { id: 'digest', label: 'digest', count: 2, inFile: true },
            { id: 'removed-one', label: 'removed-one', count: 1, inFile: false },
            // An agent's request reads as its rows do.
            { id: 'consola#delete_session', label: 'Delete session', count: 1, inFile: false },
        ]);
    });

    it('keeps the chosen automation listed when nothing else would list it', () => {
        expect(runAutomationOptions(snapshot([]), [], 'gone')).toEqual([{ id: 'gone', label: 'gone', count: 0, inFile: false }]);
    });
});

describe('formatRunWhen', () => {
    // Local times, so the calendar days do not depend on the machine's zone.
    const now = new Date(2026, 10, 12, 20, 0);
    const at = (month: number, day: number, hour: number, year = 2026) => new Date(year, month, day, hour, 28);
    const time = (date: Date) => date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

    it('says only the time today, "Yesterday" the day before, and the weekday within the week', () => {
        const today = at(10, 12, 18);
        const yesterday = at(10, 11, 9);
        const thisWeek = at(10, 7, 9);
        expect(formatRunWhen(today.toISOString(), now)).toBe(time(today));
        expect(formatRunWhen(yesterday.toISOString(), now)).toBe(`Yesterday, ${time(yesterday)}`);
        expect(formatRunWhen(thisWeek.toISOString(), now)).toBe(
            `${thisWeek.toLocaleDateString(undefined, { weekday: 'short' })}, ${time(thisWeek)}`,
        );
    });

    it('says the date from a week back, with the year only when it is not this one', () => {
        const lastWeek = at(10, 5, 9);
        const lastYear = at(11, 30, 9, 2025);
        expect(formatRunWhen(lastWeek.toISOString(), now)).toBe(
            `${lastWeek.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time(lastWeek)}`,
        );
        expect(formatRunWhen(lastYear.toISOString(), now)).toContain(
            lastYear.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
        );
    });

    it('says nothing for a time it cannot read', () => {
        expect(formatRunWhen('not a date', now)).toBe('');
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

describe('formatAgo', () => {
    it('counts minutes, hours and days back, and says the date from a week back', () => {
        expect(formatAgo(ago(20_000), NOW)).toBe('just now');
        expect(formatAgo(ago(14 * 60_000), NOW)).toBe('14m ago');
        expect(formatAgo(ago(3 * HOUR + 59 * 60_000), NOW)).toBe('3h ago');
        expect(formatAgo(ago(2 * DAY + HOUR), NOW)).toBe('2d ago');
        expect(formatAgo(ago(9 * DAY), NOW)).toBe(formatRunWhen(ago(9 * DAY), NOW).split(',')[0]);
        expect(formatAgo('not a date', NOW)).toBe('');
    });
});

describe('formatCountdown', () => {
    const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

    it('counts down in minutes, then hours and minutes, then days and hours', () => {
        expect(formatCountdown(ahead(14 * 60_000), NOW)).toBe('in 14m');
        expect(formatCountdown(ahead(3 * HOUR + 12 * 60_000), NOW)).toBe('in 3h 12m');
        expect(formatCountdown(ahead(5 * HOUR), NOW)).toBe('in 5h');
        expect(formatCountdown(ahead(2 * DAY + 4 * HOUR), NOW)).toBe('in 2d 4h');
        expect(formatCountdown(ahead(3 * DAY), NOW)).toBe('in 3d');
    });

    it('rounds minutes up, so it never says "in 0m" while time is left', () => {
        expect(formatCountdown(ahead(10_000), NOW)).toBe('in 1m');
        expect(formatCountdown(ahead(59 * 60_000 + 30_000), NOW)).toBe('in 1h');
    });

    it('is due now once the time has come', () => {
        expect(formatCountdown(NOW.toISOString(), NOW)).toBe('due now');
        expect(formatCountdown(ago(30_000), NOW)).toBe('due now');
        expect(formatCountdown('not a date', NOW)).toBe('');
    });
});

describe('formatDueAt', () => {
    // Local times, so the calendar days do not depend on the machine's zone.
    const now = new Date(2026, 10, 12, 8, 0);
    const at = (month: number, day: number, hour: number, year = 2026) => new Date(year, month, day, hour, 30);
    const time = (date: Date) => date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

    it('says only the time today, "Tomorrow" the day after, and the weekday within the week', () => {
        const today = at(10, 12, 21);
        const tomorrow = at(10, 13, 9);
        const thisWeek = at(10, 16, 9);
        expect(formatDueAt(today.toISOString(), now)).toBe(time(today));
        expect(formatDueAt(tomorrow.toISOString(), now)).toBe(`Tomorrow, ${time(tomorrow)}`);
        expect(formatDueAt(thisWeek.toISOString(), now)).toBe(
            `${thisWeek.toLocaleDateString(undefined, { weekday: 'short' })}, ${time(thisWeek)}`,
        );
    });

    it('says the date from a week ahead, with the year only when it is not this one', () => {
        const nextWeek = at(10, 20, 9);
        const nextYear = at(0, 2, 9, 2027);
        expect(formatDueAt(nextWeek.toISOString(), now)).toBe(
            `${nextWeek.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time(nextWeek)}`,
        );
        expect(formatDueAt(nextYear.toISOString(), now)).toContain('2027');
    });
});

describe('recentRuns', () => {
    it("draws one automation's latest runs, oldest first, capped", () => {
        const runs = [
            run({ id: 'new', createdAt: ago(HOUR) }),
            run({ id: 'other', automationId: 'other', createdAt: ago(2 * HOUR) }),
            run({ id: 'mid', createdAt: ago(3 * HOUR) }),
            run({ id: 'old', createdAt: ago(4 * HOUR) }),
        ];
        expect(recentRuns(runs, 'review-prs', NOW).map((entry) => entry.id)).toEqual(['old', 'mid', 'new']);
        expect(recentRuns(runs, 'review-prs', NOW, 2).map((entry) => entry.id)).toEqual(['mid', 'new']);
    });

    it('leaves out what history has dropped, as Activity does', () => {
        const runs = [run({ id: 'kept', createdAt: ago(DAY) }), run({ id: 'gone', createdAt: ago(40 * DAY) })];
        expect(recentRuns(runs, 'review-prs', NOW).map((entry) => entry.id)).toEqual(['kept']);
    });
});

describe('historySlots', () => {
    it('pads on the left, so the newest run is always the last slot', () => {
        expect(historySlots(['a', 'b'], 4)).toEqual([null, null, 'a', 'b']);
        expect(historySlots([], 3)).toEqual([null, null, null]);
    });

    it('keeps only the newest runs when there are more than slots', () => {
        expect(historySlots(['a', 'b', 'c', 'd'], 3)).toEqual(['b', 'c', 'd']);
    });
});

describe('recentRunsInWords', () => {
    it('counts each outcome, completed first', () => {
        const runs = [run({ status: 'failed' }), run(), run(), run({ status: 'running' })];
        expect(recentRunsInWords(runs)).toBe('Last 4 runs: 2 completed, 1 failed, 1 running');
    });

    it('says "all" when every run went the same way', () => {
        expect(recentRunsInWords([run(), run(), run()])).toBe('Last 3 runs: all completed');
        expect(recentRunsInWords([run({ status: 'failed' })])).toBe('Last run: failed');
        expect(recentRunsInWords([])).toBe('No runs in the last 30 days');
    });
});

describe('latestRun', () => {
    it('speaks for a run waiting for the person first, however old', () => {
        const waiting = run({ id: 'w', status: 'needs-approval', createdAt: ago(DAY) });
        const latest = latestRun([waiting, run({ id: 'done', createdAt: ago(HOUR) })], NOW);
        expect(latest).toMatchObject({ tone: 'needs-approval', label: 'Waiting for you', detail: '1d ago' });
        expect(latest?.run.id).toBe('w');
    });

    it('then a running run, with how long it has worked', () => {
        const running = run({ id: 'r', status: 'running', startedAt: ago(72_000), createdAt: ago(2 * HOUR) });
        expect(latestRun([running, run({ id: 'done' })], NOW)).toMatchObject({ label: 'Running', detail: 'for 1m 12s' });
    });

    it('then a queued run, with its place in line when it has one', () => {
        const queued = run({ id: 'q', status: 'queued', createdAt: ago(5 * 60_000) });
        expect(latestRun([queued], NOW, () => 2)).toMatchObject({ label: 'Queued', detail: '2 in line' });
        expect(latestRun([queued], NOW)).toMatchObject({ label: 'Queued', detail: '5m ago' });
    });

    it('else the newest, by when it ended', () => {
        const older = run({ id: 'a', createdAt: ago(3 * HOUR) });
        const newest = run({ id: 'b', status: 'failed', createdAt: ago(2 * HOUR), finishedAt: ago(HOUR) });
        expect(latestRun([older, newest], NOW)).toMatchObject({ tone: 'failed', label: 'Failed', detail: '1h ago' });
        expect(latestRun([], NOW)).toBeNull();
    });
});
