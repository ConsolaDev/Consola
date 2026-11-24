import type { EntryKey } from './entry';
import type { TreeNode } from './forest';

/**
 * Every row key in the order the sidebar draws it: the list, then Working,
 * Snoozed and Settled. Each section is given as drawn (folded shelves already
 * cut down, filtered rows already gone), and `childrenShown` says which
 * children a conductor shows, so a range never reaches a row the person
 * cannot see.
 */
export function drawnOrder(
  sections: ReadonlyArray<readonly TreeNode[]>,
  childrenShown: (node: TreeNode) => readonly TreeNode[],
): EntryKey[] {
  const keys: EntryKey[] = [];
  const walk = (node: TreeNode) => {
    keys.push(node.entry.key);
    for (const child of childrenShown(node)) walk(child);
  };
  for (const nodes of sections) for (const node of nodes) walk(node);
  return keys;
}

/** The rows from `anchor` to `key` in drawn order, either way round; just `key` with no usable anchor. */
export function rangeBetween(
  order: readonly EntryKey[],
  anchor: EntryKey | null,
  key: EntryKey,
): EntryKey[] {
  const to = order.indexOf(key);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  if (to < 0) return [];
  if (from < 0) return [key];
  const [start, end] = from <= to ? [from, to] : [to, from];
  return order.slice(start, end + 1);
}

/** The selection with only what is still drawn, in drawn order. */
export function pruneSelection(
  selected: readonly EntryKey[],
  order: readonly EntryKey[],
): EntryKey[] {
  const keep = new Set(selected);
  return order.filter((key) => keep.has(key));
}

/** Whether a click asks to change the selection rather than open the row: ⌘ on a Mac, Ctrl elsewhere, or Shift. */
export function selectionGesture(
  event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  isMac: boolean,
): 'toggle' | 'range' | null {
  if (event.shiftKey) return 'range';
  if (isMac ? event.metaKey : event.ctrlKey) return 'toggle';
  return null;
}
