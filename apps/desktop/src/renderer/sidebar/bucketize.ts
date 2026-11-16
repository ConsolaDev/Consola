import type { Entry } from './entry';
import { aggregateAttention, membersOf, type TreeNode } from './forest';

export type Bucket = 'waiting' | 'done' | 'working' | 'recent' | 'settled';

const byKey = (a: TreeNode, b: TreeNode) => (a.entry.key < b.entry.key ? -1 : a.entry.key > b.entry.key ? 1 : 0);

const maxOf = (node: TreeNode, pick: (entry: Entry) => number): number =>
  Math.max(...membersOf(node).map(pick));

/** Newest first; ties break on key so the order never shuffles. */
function newestFirst(nodes: TreeNode[], pick: (node: TreeNode) => number): TreeNode[] {
  return [...nodes].sort((a, b) => pick(b) - pick(a) || byKey(a, b));
}

const lastActivity = (node: TreeNode) => maxOf(node, (entry) => entry.activityAt);
const lastFinished = (node: TreeNode) => maxOf(node, (entry) => entry.finishedAt ?? 0);
/** A tree has waited since its longest-waiting member that needs the person. */
const waitingSince = (node: TreeNode) =>
  Math.min(...membersOf(node).filter((entry) => entry.attention === 'needs-attention').map((entry) => entry.since));

/**
 * Places each tree in exactly one bucket by its aggregate attention. Needs-you
 * and done come before working, so a row that needs the person is never in a
 * foldable shelf: that guarantee is structural, not a special case in the fold.
 */
export function bucketize(roots: TreeNode[]): Record<Bucket, TreeNode[]> {
  const placed: Record<Bucket, TreeNode[]> = { waiting: [], done: [], working: [], recent: [], settled: [] };
  for (const root of roots) {
    switch (aggregateAttention(root)) {
      case 'needs-attention': placed.waiting.push(root); break;
      case 'done': placed.done.push(root); break;
      case 'working': placed.working.push(root); break;
      case 'settled': placed.settled.push(root); break;
      default: placed.recent.push(root);
    }
  }
  return {
    // Longest-waiting first, so arrivals append instead of pushing rows under the cursor.
    waiting: [...placed.waiting].sort((a, b) => waitingSince(a) - waitingSince(b) || byKey(a, b)),
    done: newestFirst(placed.done, lastFinished),
    working: newestFirst(placed.working, lastActivity),
    recent: newestFirst(placed.recent, lastActivity),
    settled: newestFirst(placed.settled, lastActivity),
  };
}
