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

export interface CheckoutContext {
  branch?: string;
  refs: string[];
  localBranches: string[];
  worktrees: CheckoutWorktree[];
}
