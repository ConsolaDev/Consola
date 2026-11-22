import { PR_ITEM_NEEDS_PRS, type Automation, type RunRecord } from '@consola/factory-spec';
import type { ItemSource } from '../sources/itemSource';
import type { CheckoutKind } from '../ports';
import type { ItemRef } from '../views';
import { itemRefOf } from './agentStep';
import type { RunDefinition } from './definition';

/**
 * An item run's checkout, as the engine asks its host for it. The policy is
 * the engine's (prepared once before the first step, the run failing before
 * it on a throw, `head` recorded, held while the run works); the git and the
 * provider's checkout are the host's.
 */
export interface CheckoutRequest {
  workspaceId: string;
  workItem: ItemRef;
  /**
   * Set when a trigger fired the run and its first agent step is an action:
   * a session the person started on the item with that action after `since`
   * refuses the preparation (`StartedByHandError`), checked under the lock
   * an Inbox click takes.
   */
  startedByHand?: { label: string; since: string };
}

/** What the run records as its checkout. */
export interface PreparedCheckout {
  cwd: string;
  scopeId: string;
  /** `git rev-parse HEAD` there: the commit the run reads, `CONSOLA_CHECKOUT_HEAD` to its commands. */
  head: string;
}

export interface CheckoutPort {
  /** Where the item's automation checkout is, prepared or not: what a working run holds. */
  pathFor(workspaceId: string, workItem: ItemRef): string;
  /** Bring it to the item's head and say which commit that is; throws with the reason it could not, or StartedByHandError. */
  prepare(request: CheckoutRequest): Promise<PreparedCheckout>;
}

/**
 * The kind of checkout an entry's runs work in, from its file alone: `item`
 * for an event entry, a poll with `item:` and `on: manual` with
 * `applies_to:`, each without `scope:` (`resolve` refuses `scope:` on items
 * that have a repository, and requires it on items that have none); `scope`
 * for everything else. What its agents are checked for at apply.
 */
export function entryCheckoutKind(automation: Automation): CheckoutKind {
  if (automation.scope) return 'scope';
  const { trigger } = automation;
  if (trigger.kind === 'event') return 'item';
  if (trigger.kind === 'poll' && trigger.item !== undefined) return 'item';
  if (trigger.kind === 'manual' && (automation.appliesTo?.length ?? 0) > 0) return 'item';
  return 'scope';
}

/**
 * The kind of checkout a run works in, from three witnesses, any of which
 * makes it `item`: its definition says so, its recorded checkout has a
 * `head` (only an item's preparation records one), or its entry names no
 * scope and the run has a work item (what `startStepsRun` works in an item's
 * checkout for). A definition that says `scope` never outvotes the others:
 * any doubt reads as `item`, the stricter.
 */
export function runCheckoutKind(run: RunRecord, definition: RunDefinition): CheckoutKind {
  if (definition.checkout === 'item') return 'item';
  if (run.checkout?.head !== undefined) return 'item';
  if (!definition.automation.scope && itemRefOf(run) !== undefined) return 'item';
  return 'scope';
}

/**
 * Whether an entry's runs carry an item, text other people wrote: an event,
 * any poll (`key:` or `item:`), `on: manual` with `applies_to:` (what
 * factory-spec calls an item kind other than `none`). Not the checkout kind:
 * north-star §4.2's investigator is a poll with `key:` and `scope:`, which
 * works in its scope and still reads an alert someone else wrote.
 */
export function entryReadsItems(automation: Automation): boolean {
  const { trigger } = automation;
  switch (trigger.kind) {
    case 'event':
    case 'poll':
      return true;
    case 'manual':
      return (automation.appliesTo?.length ?? 0) > 0;
    case 'cron':
      return false;
  }
}

/**
 * Why an entry's `checkout: { pr: item }` cannot hold: its source's items are
 * never pull requests (an event or a poll's `item:` whose connection gives
 * none), or it has no source at all. Null when it holds, or the entry does
 * not name it. Factory-spec refuses what it can tell from the file alone (a
 * schedule, a keyed poll, `on: manual` without `pr`); this is the rest.
 */
export function prCheckoutProblem(
  automation: Pick<Automation, 'checkout'>,
  source: Pick<ItemSource, 'itemTypes'> | undefined,
): string | null {
  if (automation.checkout?.pr !== 'item') return null;
  return source?.itemTypes.includes('pr') ? null : PR_ITEM_NEEDS_PRS;
}
