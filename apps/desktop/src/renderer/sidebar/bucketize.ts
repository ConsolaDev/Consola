import type { Entry } from './entry';
import { aggregateAttention, membersOf, type TreeNode } from './forest';

/**
 * The sections of the list.
 *
 * `waiting` is everything in play that is not running: a question for the
 * person, a result nobody has read, an idle prompt, a process that exited.
 * Each of those waits on the person in its own way — to answer, to read, to
 * type the next prompt, to reopen — so they share the top of the list, under
 * no heading, and the row says which it is (`RowStatus`). `working` is what is
 * running. `settled` holds only what was put away, by hand or by the
 * AutoSettler after sitting idle.
 *
 * Stopping is not settling. A session that merely stopped is still in play
 * until someone puts it away; filing it under Settled the moment its turn
 * ended would bury nearly the whole list in a shelf at the bottom.
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
 * The top of the list in three tiers: questions, then results nobody has read,
 * then what is merely idle or exited.
 *
 * Questions come first and longest-waiting first, so an arrival appends rather
 * than pushing rows under the cursor. A finish comes next, newest first, so it
 * arrives where it can be seen instead of somewhere among every idle session.
 * The idle tail is newest first by activity.
 */
function waitingOrder(nodes: TreeNode[]): TreeNode[] {
  const tier = (node: TreeNode) => aggregateAttention(node);
  const asking = nodes.filter((node) => tier(node) === 'needs-attention');
  const unseen = nodes.filter((node) => tier(node) === 'done');
  const idle = nodes.filter((node) => tier(node) !== 'needs-attention' && tier(node) !== 'done');
  return [
    ...[...asking].sort((a, b) => waitingSince(a) - waitingSince(b) || byKey(a, b)),
    ...newestFirst(unseen, lastFinished),
    ...newestFirst(idle, lastActivity),
  ];
}

/**
 * Places each tree in exactly one bucket by its aggregate attention. A tree
 * reaches Settled only when every member was put away, because a settled
 * session is the lowest rank; and a row that needs the person is never in a
 * foldable shelf, because that rank is placed before anything else.
 */
export function bucketize(roots: TreeNode[]): Record<Bucket, TreeNode[]> {
  const placed: Record<Bucket, TreeNode[]> = { waiting: [], working: [], settled: [] };
  for (const root of roots) {
    switch (aggregateAttention(root)) {
      case 'working': placed.working.push(root); break;
      case 'settled': placed.settled.push(root); break;
      // `needs-attention`, `done`, `ready` and `exited`: in play, not running.
      default: placed.waiting.push(root);
    }
  }
  return {
    waiting: waitingOrder(placed.waiting),
    working: newestFirst(placed.working, lastActivity),
    settled: newestFirst(placed.settled, lastActivity),
  };
}
