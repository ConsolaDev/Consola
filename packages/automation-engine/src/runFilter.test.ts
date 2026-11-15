import { describe, expect, it } from 'vitest';
import { filterRuns, NO_RUN_FILTER, type RunListFilter } from './runFilter';
import type { RunListEntry } from './views';

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
