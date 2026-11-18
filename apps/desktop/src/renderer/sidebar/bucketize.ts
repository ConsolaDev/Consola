import type { Attention } from '../../shared/attention';
import type { Entry } from './entry';
import { aggregateAttention, membersOf, type TreeNode } from './forest';
import type { WorkingObservation } from './workingExits';

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

export interface Arrangement {
  /**
   * Whether running work gets its own section. Without one, a running tree
   * stays where it is in the list, and the list moves only when something is
   * added or woken from Settled: what the row is doing shows on the row.
   */
  workingSection: boolean;
  /** What the list has seen trees do in Working (`workingExits`). Absent, nothing has been seen. */
  observed?: WorkingObservation;
}

const byKey = (a: TreeNode, b: TreeNode) =>
  a.entry.key < b.entry.key ? -1 : a.entry.key > b.entry.key ? 1 : 0;

const maxOf = (node: TreeNode, pick: (entry: Entry) => number): number =>
  Math.max(...membersOf(node).map(pick));

/** Newest first; ties break on key so the order never shuffles. */
function newestFirst(nodes: TreeNode[], pick: (node: TreeNode) => number): TreeNode[] {
  return [...nodes].sort((a, b) => pick(b) - pick(a) || byKey(a, b));
}

const lastActivity = (node: TreeNode) => maxOf(node, (entry) => entry.activityAt);

/** The latest moment an entry arrived in the list: created, woken, prompted or finished. */
const arrivedAt = (entry: Entry) =>
  Math.max(entry.createdAt, entry.unsettledAt ?? 0, entry.activityAt, entry.finishedAt ?? 0);

/** Where a tree sits when nothing that runs may move it: its root's creation or waking. */
const placedAt = (node: TreeNode) => Math.max(node.entry.createdAt, node.entry.unsettledAt ?? 0);

/**
 * Places each tree in exactly one bucket by its aggregate attention. A tree
 * reaches Settled only when every member was put away, because a settled
 * session is the lowest rank; and a row that needs the person is never in a
 * foldable shelf, because that rank is placed before anything else.
 *
 * The top of the list has one order: whatever came back most recently is
 * first. A session being made, prompted or woken from Settled counts, and so
 * does a run ending, finished or stopped on a question; nothing else does, so
 * reading a row never moves it. A tree that left Working comes back at the
 * moment the list saw it leave (`returnedAt`), the one time the ledger has no
 * record of when a run stops on a question.
 *
 * Working is newest first by when its run started, as the list saw it, so a
 * subagent starting inside a running tree does not lift it, and a tree still
 * in its grace (`lingering`) keeps its place while it finishes.
 */
export function bucketize(
  roots: TreeNode[],
  { workingSection, observed }: Arrangement = { workingSection: true },
): Record<Bucket, TreeNode[]> {
  const placed: Record<Bucket, TreeNode[]> = { waiting: [], working: [], settled: [] };
  // A question is never held in a foldable shelf, whatever was observed.
  const lingers = (root: TreeNode, attention: Attention) =>
    attention !== 'needs-attention' && observed?.lingering.has(root.entry.key) === true;
  for (const root of roots) {
    const attention = aggregateAttention(root);
    if (attention === 'settled') placed.settled.push(root);
    else if (workingSection && (attention === 'working' || lingers(root, attention)))
      placed.working.push(root);
    // In play and not running: `needs-attention`, `done`, `ready`, `exited`.
    // Without a Working section, running trees stay here too.
    else placed.waiting.push(root);
  }
  const returned = (node: TreeNode) => observed?.returnedAt.get(node.entry.key) ?? 0;
  const started = (node: TreeNode) =>
    observed?.workingSince.get(node.entry.key) ?? lastActivity(node);
  return {
    waiting: workingSection
      ? newestFirst(placed.waiting, (node) => Math.max(maxOf(node, arrivedAt), returned(node)))
      : newestFirst(placed.waiting, placedAt),
    working: newestFirst(placed.working, started),
    settled: newestFirst(placed.settled, lastActivity),
  };
}
