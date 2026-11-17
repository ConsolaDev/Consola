import type { Entry } from './entry';
import { aggregateAttention, membersOf, type TreeNode } from './forest';

/**
 * The sections of the list. Two say what a session is doing — it is waiting on
 * you, or it is running — and the third holds everything that has stopped.
 *
 * There is deliberately no bucket between "running" and "stopped". A row used
 * to be able to land in a "recent" bucket that was neither, which drew an
 * unheaded run of rows in the middle of the list and left the person working
 * out what it meant. `done`, `ready` and `exited` are not a different *kind*
 * of thing from each other, nor from a session put on the shelf by hand:
 * all four have stopped, and whether the process happens to still be alive,
 * or whether someone pressed Settle, is not a reason to file them under
 * separate headings. Settled is one foldable section, and what is unread
 * inside it is said by the row (`RowStatus`) and by its order, not by a
 * heading of its own.
 */
export type Bucket = 'waiting' | 'working' | 'settled';

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
 * Settled in three tiers: results nobody has looked at yet, then what has
 * merely stopped, then what someone put away on purpose.
 *
 * Without the first split a finish would arrive somewhere in the middle of
 * every session that has ever stopped, which is the whole section. That tier
 * is also what the fold is about: `visibleNodes` keeps an unread result on
 * screen through a collapsed shelf, so a turn finishing still surfaces.
 *
 * The last tier is what keeps Settle a move you can see. Everything stopped
 * shares one section now, so a shelved row that happened to be active
 * recently would otherwise sit above a session nobody has touched in a week,
 * and pressing Settle would do nothing visible at all. Put away means last.
 * Within each tier the newest is first, by the clock that tier is about.
 */
function settledOrder(nodes: TreeNode[]): TreeNode[] {
  const tier = (node: TreeNode) => aggregateAttention(node);
  const unseen = nodes.filter((node) => tier(node) === 'done');
  const stopped = nodes.filter((node) => tier(node) !== 'done' && tier(node) !== 'settled');
  const shelved = nodes.filter((node) => tier(node) === 'settled');
  return [
    ...newestFirst(unseen, lastFinished),
    ...newestFirst(stopped, lastActivity),
    ...newestFirst(shelved, lastActivity),
  ];
}

/**
 * Places each tree in exactly one bucket by its aggregate attention. Waiting
 * comes before working, so a row that needs the person is never in a foldable
 * shelf: that guarantee is structural, not a special case in the fold.
 */
export function bucketize(roots: TreeNode[]): Record<Bucket, TreeNode[]> {
  const placed: Record<Bucket, TreeNode[]> = { waiting: [], working: [], settled: [] };
  for (const root of roots) {
    switch (aggregateAttention(root)) {
      case 'needs-attention': placed.waiting.push(root); break;
      case 'working': placed.working.push(root); break;
      // `done`, `ready`, `exited` and `settled`: a session that has stopped.
      default: placed.settled.push(root);
    }
  }
  return {
    // Longest-waiting first, so arrivals append instead of pushing rows under the cursor.
    waiting: [...placed.waiting].sort((a, b) => waitingSince(a) - waitingSince(b) || byKey(a, b)),
    working: newestFirst(placed.working, lastActivity),
    settled: settledOrder(placed.settled),
  };
}
