import type { EntryKey } from './entry';
import { aggregateAttention, membersOf, type TreeNode } from './forest';

/** What a row offers about the Settled shelf. */
export type SettleOffer =
  | { kind: 'settle' }
  | { kind: 'unsettle' }
  /** Not available, and why: a menu can show the reason, a hover slot just stays out of the way. */
  | { kind: 'blocked'; reason: string };

/** `done` is idle too: settling it marks it seen, which drops it out of Settled's unread tier and behind the fold — putting a looked-at result away is the gesture. */
const IDLE = new Set(['ready', 'exited', 'settled', 'done']);

/**
 * Whether settling this row puts it on the shelf, which is the only honest
 * reason to offer it. The sidebar buckets whole trees by their worst member and
 * a settled session is the lowest rank, so a tree reaches the shelf only when
 * every member does; and a session reads settled only while its terminal is
 * idle, so settling a working row writes something the next turn discards.
 * Restricting the offer to those cases is the safety property too: a session
 * that is working or needs the person cannot be hidden, and a child cannot
 * leave a tree its parent still holds. What only main can see (an open run
 * holding a session) is not decided here: main verifies the settle and the
 * toast reports what happened.
 *
 * `node` is the row's own tree node, a conductor with its children or a lone
 * session; `isChild` says it is drawn under a conductor; `viewedKey` is the
 * entry this window is showing, which is never offered Settle — the sweeper
 * skips what a window is showing for the same reason, and by hand the row
 * would bounce: opening a session makes its CLI paint, and that activity
 * un-settles it a second after the toast said it had reached the shelf.
 * A tree settles as one, so a conductor is blocked by a viewed child too.
 */
export function settleOffer(node: TreeNode, isChild: boolean, viewedKey: EntryKey | null = null): SettleOffer {
  if (isChild) return { kind: 'blocked', reason: 'Settles with its conductor' };
  if (aggregateAttention(node) === 'settled') return { kind: 'unsettle' };
  const members = membersOf(node);
  // After the unsettle case: a settled row the person opened still offers the
  // way back, which is the move opening it is about to make anyway.
  if (viewedKey !== null && members.some((member) => member.key === viewedKey)) {
    return { kind: 'blocked', reason: 'Not while you have it open' };
  }
  if (members.some((member) => !IDLE.has(member.attention))) {
    return { kind: 'blocked', reason: 'Not while it is working or needs you' };
  }
  // Only a root that is itself ready or exited: one already settled has nothing to settle.
  return node.entry.attention === 'settled' ? { kind: 'blocked', reason: 'Settles with its children' } : { kind: 'settle' };
}
