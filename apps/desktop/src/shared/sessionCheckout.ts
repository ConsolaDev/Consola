/** A launch intent, resolved in main before the session record is created. */
export type SessionCheckout =
  | { mode: 'current' }
  | { mode: 'existing'; path: string }
  | { mode: 'new'; baseRef: string; branchName?: string; useExistingBranch?: boolean };

export interface CheckoutWorktree {
  path: string;
  branch?: string;
  head: string;
  current: boolean;
  unavailable?: boolean;
}

/**
 * Which checkout a folder is, as git sees it — read from the folder rather
 * than the session record, because a worktree can also be opened as a scope,
 * and only git knows what a folder is.
 *
 * `worktree` means a linked worktree: its own branch, index and changes, apart
 * from the repository's own checkout (`main`), which is the folder people
 * usually open in their editor.
 */
export type CheckoutInfo =
  | { kind: 'none' }
  | {
      kind: 'main' | 'worktree';
      /** The checkout's top level. */
      root: string;
      /** The repository's own checkout, which every worktree hangs off. */
      mainCheckout: string;
      /** The branch checked out; absent while HEAD is detached. */
      branch?: string;
      /** The abbreviated commit, given only when HEAD is detached. */
      head?: string;
    };

/** What a checkout has checked out: a branch, or the commit a detached HEAD is on. */
export function checkoutRef(checkout: Exclude<CheckoutInfo, { kind: 'none' }>): string {
  return checkout.branch ?? `detached ${checkout.head ?? 'HEAD'}`;
}

export interface CheckoutContext {
  branch?: string;
  refs: string[];
  localBranches: string[];
  worktrees: CheckoutWorktree[];
}
