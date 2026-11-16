import { aggregateAttention, membersOf, type TreeNode } from './forest';

/** What a row offers about the Settled shelf. */
export type SettleOffer =
  | { kind: 'settle' }
  | { kind: 'unsettle' }
  /** Not available, and why: a menu can show the reason, a hover slot just stays out of the way. */
  | { kind: 'blocked'; reason: string };

const IDLE = new Set(['ready', 'exited', 'settled']);

/**
 * Whether settling this row puts it on the shelf, which is the only honest
 * reason to offer it. The sidebar buckets whole trees by their worst member and
 * a settled session is the lowest rank, so a tree reaches the shelf only when
 * every member does; and a session reads settled only while its terminal is
 * idle, so settling a working row writes something the next turn discards.
 * Restricting the offer to those cases is the safety property too: a session
 * that is working or needs the person cannot be hidden, and a child cannot
 * leave a tree its parent still holds.
 *
 * `node` is the row's own tree node, a conductor with its children or a lone
 * session; `isChild` says it is drawn under a conductor.
 */
export function settleOffer(node: TreeNode, isChild: boolean): SettleOffer {
  if (isChild) return { kind: 'blocked', reason: 'Settles with its conductor' };
  if (aggregateAttention(node) === 'settled') return { kind: 'unsettle' };
  const members = membersOf(node);
  if (members.some((member) => !IDLE.has(member.attention))) {
    return { kind: 'blocked', reason: 'Not while it is working, needs you, or has a result you have not seen' };
  }
  // Only a root that is itself ready or exited: one already settled has nothing to settle.
  return node.entry.attention === 'settled' ? { kind: 'blocked', reason: 'Settles with its children' } : { kind: 'settle' };
}
