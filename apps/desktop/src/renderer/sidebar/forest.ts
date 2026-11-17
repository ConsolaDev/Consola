import { worstStatus, type Attention } from '../../shared/attention';
import type { Entry, EntryKey } from './entry';

export interface TreeNode {
  entry: Entry;
  children: TreeNode[];
}

/**
 * Entries arranged as conductor trees, one level deep.
 *
 * A parent that does not resolve makes its entry a root rather than dropping
 * it (resolution on read, as `resolveRememberedView` does). Anything deeper
 * than one level is flattened under its top conductor, and a parent cycle
 * breaks at the entry that closes it. Every entry appears exactly once, in
 * input order.
 */
export function buildForest(entries: Entry[]): TreeNode[] {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));

  const topOf = (entry: Entry): Entry => {
    const seen = new Set<EntryKey>([entry.key]);
    let current = entry;
    while (current.parent !== undefined) {
      const next = byKey.get(current.parent);
      if (!next) return current;
      if (seen.has(next.key)) return entry; // cycle: nobody above can be trusted to be the root
      seen.add(next.key);
      current = next;
    }
    return current;
  };

  const nodes = new Map<EntryKey, TreeNode>(entries.map((entry) => [entry.key, { entry, children: [] }]));
  const roots: TreeNode[] = [];
  for (const entry of entries) {
    const top = topOf(entry);
    const node = nodes.get(entry.key)!;
    if (top.key === entry.key) roots.push(node);
    else nodes.get(top.key)!.children.push(node);
  }
  return roots;
}

/** The most urgent attention in a node's tree. Never empty: the node counts itself. */
export function aggregateAttention(node: TreeNode): Attention {
  const worst = worstStatus([node.entry.attention, ...node.children.map((child) => child.entry.attention)]);
  if (worst === undefined) throw new Error('A tree node always has its own attention');
  return worst;
}

/** The node and every descendant. */
export function membersOf(node: TreeNode): Entry[] {
  return [node.entry, ...node.children.flatMap(membersOf)];
}
