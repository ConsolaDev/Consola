import type { EntryKey } from './entry';
import { aggregateAttention, membersOf } from './forest';
import type { TreeNode } from './forest';

/**
 * What a shelf shows. Expanded shows everything; collapsed keeps only what must
 * never vanish: a node that needs the person or has finished, and any tree
 * holding the active session. A running session must never be absent from both
 * the list and the expanded shelf. One function serves every shelf and a
 * conductor's children, so the mitigations are written once.
 */
export function visibleNodes(
  nodes: TreeNode[],
  collapsed: boolean,
  activeKey: EntryKey | null,
): TreeNode[] {
  if (!collapsed) return nodes;
  return nodes.filter((node) => isPinned(node, activeKey));
}

function isPinned(node: TreeNode, activeKey: EntryKey | null): boolean {
  const attention = aggregateAttention(node);
  if (attention === 'needs-attention' || attention === 'done') return true;
  return activeKey !== null && membersOf(node).some((entry) => entry.key === activeKey);
}

/** The count a collapsed header shows: sessions, with a conductor counted beside its children. */
export function leafCount(nodes: TreeNode[]): number {
  return nodes.reduce((total, node) => total + membersOf(node).length, 0);
}
