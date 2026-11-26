import type { Attention } from '../../shared/attention';
import type { Entry } from './entry';
import { aggregateAttention, membersOf } from './forest';
import type { TreeNode } from './forest';
import type { WorkingObservation } from './workingExits';

/**
 * The sections of the list.
 *
 * `waiting` is everything in play that is not running: a question for the
 * person, a result nobody has read, an idle prompt, a process that exited.
 * Each of those waits on the person in its own way — to answer, to read, to
 * type the next prompt, to reopen — so they share the top of the list, under
 * no heading, and the row says which it is (`RowStatus`). `working` is what is
 * running. `snoozed` holds what was put away until a time, and comes back by
 * itself. `settled` holds only what was put away for good, by hand or by the
 * AutoSettler after sitting idle.
 *
 * Stopping is not settling. A session that merely stopped is still in play
 * until someone puts it away; filing it under Settled the moment its turn
 * ended would bury nearly the whole list in a shelf at the bottom.
 */
export type Bucket = 'waiting' | 'working' | 'snoozed' | 'settled';

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

/** Newest first by each pick in turn; ties break on key so the order never shuffles. */
function newestFirst(nodes: TreeNode[], ...picks: Array<(node: TreeNode) => number>): TreeNode[] {
  const byPicks = (a: TreeNode, b: TreeNode) => {
    for (const pick of picks) {
      const difference = pick(b) - pick(a);
      if (difference !== 0) return difference;
    }
    return 0;
  };
  return [...nodes].sort((a, b) => byPicks(a, b) || byKey(a, b));
}

const lastActivity = (node: TreeNode) => maxOf(node, (entry) => entry.activityAt);

/** When an entry last came back to the list from a shelf: woken from Settled, or from a snooze. */
const cameBackAt = (entry: Entry) => Math.max(entry.unsettledAt ?? 0, entry.wokeAt ?? 0);

/** The latest moment an entry arrived in the list: created, woken, prompted or finished. */
const arrivedAt = (entry: Entry) =>
  Math.max(entry.createdAt, cameBackAt(entry), entry.activityAt, entry.finishedAt ?? 0);

/** Where a tree sits when nothing that runs may move it: its root's creation or waking. */
const placedAt = (node: TreeNode) => Math.max(node.entry.createdAt, cameBackAt(node.entry));

/**
 * When a settled tree went onto the shelf: the moment its last member was put
 * away, since a tree is settled only once every member is. Main writes
 * `settledAt` with every settle, so the activity fallback only keeps an entry
 * without one in a stable place.
 */
const shelvedAt = (node: TreeNode) => maxOf(node, (entry) => entry.settledAt ?? entry.activityAt);

/** When a snoozed tree comes back: its soonest member. */
const nextWake = (node: TreeNode) =>
  Math.min(...membersOf(node).map((entry) => entry.snoozedUntil ?? Number.POSITIVE_INFINITY));

/**
 * Places each tree in exactly one bucket by its aggregate attention. A tree
 * reaches Settled only when every member was put away, because a settled
 * session is the lowest rank; and a row that needs the person is never in a
 * foldable shelf, because that rank is placed before anything else. A
 * snoozed tree is on the Snoozed shelf, soonest back first, whatever its
 * children run: snoozed outranks working, so a child it starts never pulls
 * it off.
 *
 * The top of the list has one order: whatever came back most recently is
 * first. A session being made, prompted, woken from Settled or back from a
 * snooze counts, and so does a run ending, finished or stopped on a question;
 * nothing else does, so reading a row never moves it. A tree that left Working comes back at the
 * moment the list saw it leave (`returnedAt`), the one time the ledger has no
 * record of when a run stops on a question.
 *
 * Working is newest first by when its run started, as the list saw it, so a
 * subagent starting inside a running tree does not lift it, and a tree still
 * in its grace (`lingering`) keeps its place while it finishes.
 *
 * Settled is newest first by when each tree was put away, by hand or by the
 * AutoSettler, so what was just settled is at the top of the shelf however
 * old the session is or when it last worked. What one sweep or one batch put
 * away shares that moment, and keeps the order it last worked in.
 */
export function bucketize(
  roots: TreeNode[],
  { workingSection, observed }: Arrangement = { workingSection: true },
): Record<Bucket, TreeNode[]> {
  const placed: Record<Bucket, TreeNode[]> = { waiting: [], working: [], snoozed: [], settled: [] };
  // A question is never held in a foldable shelf, whatever was observed.
  const lingers = (root: TreeNode, attention: Attention) =>
    attention !== 'needs-attention' && observed?.lingering.has(root.entry.key) === true;
  for (const root of roots) {
    const attention = aggregateAttention(root);
    if (attention === 'settled') placed.settled.push(root);
    else if (attention === 'snoozed') placed.snoozed.push(root);
    else if (workingSection && (attention === 'working' || lingers(root, attention))) {
      placed.working.push(root);
    }
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
    snoozed: [...placed.snoozed].sort((a, b) => nextWake(a) - nextWake(b) || byKey(a, b)),
    settled: newestFirst(placed.settled, shelvedAt, lastActivity),
  };
}
