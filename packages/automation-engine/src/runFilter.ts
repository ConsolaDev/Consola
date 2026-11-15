import type { RunListEntry } from './views';

// A copy of the renderer's filter (`presentation.ts`), kept apart so main can
// search the whole history with the rule the panel uses. `runFilter.parity.test.ts`
// in the desktop keeps the two returning the same runs.

/** What the filter reads of a run: the narrowest equivalent of the renderer's `RunFacts` over a list entry. */
type RunFacts = RunListEntry;

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 30;

export type RunFilter = 'all' | 'agent' | 'tool' | 'failed';

/** What narrows the run list: free text, a kind, and one automation. */
export interface RunListFilter {
    query: string;
    kind: RunFilter;
    /** A run's `automationId`: an entry's name, or an agent request's tool reference. Null for every one. */
    automation: string | null;
}

export const NO_RUN_FILTER: RunListFilter = { query: '', kind: 'all', automation: null };

export function isRunFilterNarrowed(filter: RunListFilter): boolean {
    return filter.query.trim() !== '' || filter.kind !== 'all' || filter.automation !== null;
}

/** Waiting for a person or a slot, or working: history never drops these, so neither does the list. */
const LIVE_STATUSES: ReadonlySet<RunFacts['status']> = new Set(['needs-approval', 'queued', 'running']);

/**
 * The runs history keeps, newest first, narrowed by a filter. The same rule
 * as retention (`RunStore`): a run that ended in the last 30 days, by when
 * it ended, and every live run however old.
 */
export function filterRuns(runs: RunListEntry[], filter: RunListFilter, now: Date): RunListEntry[] {
    const cutoff = now.getTime() - HISTORY_DAYS * DAY_MS;
    const needle = filter.query.trim().toLowerCase();
    return runs
        .filter((run) => {
            if (LIVE_STATUSES.has(run.status)) return true;
            const ended = endedAt(run);
            return Number.isNaN(ended) || ended >= cutoff;
        })
        .filter((run) => filter.automation === null || run.automationId === filter.automation)
        .filter((run) => {
            if (filter.kind === 'agent') return run.kind === 'agent';
            if (filter.kind === 'tool') return run.kind === 'tool' || run.kind === 'request';
            if (filter.kind === 'failed') return run.status === 'failed';
            return true;
        })
        .filter((run) => {
            if (!needle) return true;
            return [run.automationId, run.trigger.item?.title, run.summary].some((text) =>
                text?.toLowerCase().includes(needle),
            );
        })
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** When a run reached its outcome: its finish, else the last time it changed. */
function endedAt(run: RunFacts): number {
    return Date.parse(run.finishedAt ?? run.updatedAt ?? run.createdAt);
}
