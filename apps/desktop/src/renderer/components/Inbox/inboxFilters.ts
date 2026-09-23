// src/renderer/components/Inbox/inboxFilters.ts
import type { InboxItem } from '../../../shared/workItems';

/**
 * GitHub's header filters, applied client-side over the cached snapshot.
 * Neither costs a request: the fetch is one query per workspace whatever
 * the filter says, and narrowing happens before sectioning and counting.
 */
export type InboxUpdatedFilter = 'week' | 'month' | 'quarter' | 'any';

/** Menu order. */
export const INBOX_UPDATED_FILTERS: ReadonlyArray<InboxUpdatedFilter> = [
  'week',
  'month',
  'quarter',
  'any',
];

export const UPDATED_FILTER_LABELS: Record<InboxUpdatedFilter, string> = {
  week: 'Last week',
  month: 'Last month',
  quarter: 'Last 3 months',
  any: 'Any time',
};

export function isInboxUpdatedFilter(value: unknown): value is InboxUpdatedFilter {
  return typeof value === 'string' && (INBOX_UPDATED_FILTERS as readonly string[]).includes(value);
}

export interface InboxFilterState {
  /** Selected `owner/name` repos; empty means no repo filter at all. */
  repos: string[];
  updated: InboxUpdatedFilter;
}

/**
 * Frozen because the store hands this very object out for every workspace
 * that has nothing saved -- one caller mutating it would filter every
 * other workspace.
 */
export const DEFAULT_INBOX_FILTER: InboxFilterState = Object.freeze({
  repos: [],
  updated: 'month',
}) as InboxFilterState;

const DAY_MS = 24 * 60 * 60 * 1000;

const UPDATED_WINDOW_MS: Record<Exclude<InboxUpdatedFilter, 'any'>, number> = {
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  quarter: 90 * DAY_MS,
};

/** Items updated inside the window; an unparseable stamp fails a bounded range. */
export function filterByUpdated(
  items: InboxItem[],
  updated: InboxUpdatedFilter,
  now: number = Date.now()
): InboxItem[] {
  if (updated === 'any') return items;
  const cutoff = now - UPDATED_WINDOW_MS[updated];
  return items.filter((item) => Date.parse(item.updatedAt) >= cutoff);
}

/** Items in the selected repos; an empty selection is no filter, never "show nothing". */
export function filterByRepos(items: InboxItem[], repos: string[]): InboxItem[] {
  if (repos.length === 0) return items;
  const wanted = new Set(repos.map((repo) => repo.toLowerCase()));
  return items.filter((item) => wanted.has(item.workItem.repo.toLowerCase()));
}

/** The repos present in a snapshot, deduped and sorted -- what the repo menu offers. */
export function reposInSnapshot(items: InboxItem[]): string[] {
  return [...new Set(items.map((item) => item.workItem.repo))].sort((a, b) => a.localeCompare(b));
}
