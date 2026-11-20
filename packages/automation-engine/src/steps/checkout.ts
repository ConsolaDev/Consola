import type { ItemRef } from '../views';

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
