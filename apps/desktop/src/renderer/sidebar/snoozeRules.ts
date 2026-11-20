import { membersOf, type TreeNode } from './forest';

/** What a row offers about the Snoozed shelf. */
export type SnoozeOffer =
  | { kind: 'snooze' }
  /** Snoozed now: Wake brings it back, and Snooze ▸ picks another time. */
  | { kind: 'wake' }
  /** Not available, and why: a menu can show the reason, a hover slot stays out of the way. */
  | { kind: 'blocked'; reason: string };

/**
 * Whether this row can be snoozed or woken. A snooze covers a conductor's
 * whole tree, so only a root is offered either; a child goes with its
 * conductor. A tree with any snoozed member is snoozed: it offers Wake, and
 * keeps Snooze ▸ for a new time. Anything else may be snoozed by the person,
 * a waiting question included ("ask me later"): only a new one ends it.
 * What only main sees (an automation using it) is verified there.
 */
export function snoozeOffer(node: TreeNode, isChild: boolean): SnoozeOffer {
  if (isChild) return { kind: 'blocked', reason: 'Snoozes with its conductor' };
  if (membersOf(node).some((member) => member.attention === 'snoozed')) return { kind: 'wake' };
  return { kind: 'snooze' };
}
