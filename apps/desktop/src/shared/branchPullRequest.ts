import type { WorkItemRef } from './workItems';

/**
 * A pull request main found from a checkout's own branch, for a session that
 * is linked to none. Shown, never stored: the session is linked only when the
 * person presses Link.
 */
export interface FoundPullRequest {
  ref: WorkItemRef;
  status: 'open' | 'merged' | 'closed';
  url: string;
}

/**
 * What main answers about a checkout's branch. `branch` is the local branch
 * the answer was read for, null when main read none, so an answer counts only
 * while the checkout is still on it.
 */
export type BranchPullRequestAnswer =
  | { kind: 'found'; branch: string; pullRequest: FoundPullRequest }
  | { kind: 'none'; branch: string | null }
  | { kind: 'failed'; branch: string; error: string };
