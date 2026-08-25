import { rankItem } from '../CommandPalette/fuzzyMatch';

export interface SearchableListItem {
  id: string;
  /** Matched against and shown; the highlight renders over it. */
  label: string;
  /** Trailing dim text, searchable as a substring (a repo, a folder). */
  context?: string;
  /** Listed but not activatable; `disabledHint` says why in its place. */
  disabled?: boolean;
  disabledHint?: string;
}

/**
 * Rank a picker's rows by the palette's matcher, so a session found here and
 * a session found in the palette agree on what "matches".
 *
 * A blank query keeps the caller's order — the caller sorted by recency or
 * by inbox position, and that order is the answer to "show me everything".
 * Disabled rows rank like any other: hiding an already-linked session would
 * make the user hunt for a row that is simply unavailable.
 */
export function rankSearchableItems<T extends SearchableListItem>(items: T[], query: string): T[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return items;

  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const match = rankItem(trimmed, item.label, item.context);
    if (match) scored.push({ item, score: match.score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.item);
}
