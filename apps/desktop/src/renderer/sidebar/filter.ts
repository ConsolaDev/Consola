import type { Entry } from './entry';

/** Selected values per facet, plus labels. Values within one are OR'd; they are AND'd across. */
export interface FilterSelection {
  labels?: string[];
  facets?: Record<string, string[]>;
}

export interface FilterResult {
  entries: Entry[];
  /** Hidden entries that need the person or have finished: the "N hidden by filter need you" count. */
  hiddenNeedingYou: number;
}

function matches(entry: Entry, selection: FilterSelection): boolean {
  const { labels = [], facets = {} } = selection;
  if (labels.length > 0 && !labels.some((id) => entry.labels.includes(id))) return false;
  return Object.entries(facets).every(([name, chosen]) =>
    chosen.length === 0 || (name in entry.facets && chosen.includes(entry.facets[name]))
  );
}

/**
 * Narrows the entries, before they are bucketed. A filter decides only which
 * entries survive; placement is bucketize's alone, over the survivors. That is
 * not the same as "a row never changes shelf": hiding a member of a tree changes
 * the tree's aggregate, so a surviving conductor can land in a different bucket
 * (and a child whose conductor is hidden becomes a root). What a filter hides
 * that needs the person is reported, never silently lost.
 */
export function applyFilter(entries: Entry[], selection: FilterSelection): FilterResult {
  const shown: Entry[] = [];
  let hiddenNeedingYou = 0;
  for (const entry of entries) {
    if (matches(entry, selection)) shown.push(entry);
    else if (entry.attention === 'needs-attention' || entry.attention === 'done') hiddenNeedingYou += 1;
  }
  return { entries: shown, hiddenNeedingYou };
}
