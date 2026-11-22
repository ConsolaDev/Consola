/**
 * Which pull request or issue the info panel's Pull request section is
 * about, and what the section shows for it. Pure: the section draws what
 * this decides.
 */
import type { WorkItemRef } from '../../shared/workItems';
import type { Session, Workspace } from '../../shared/workspace';
import type { BranchPullRequestEntry } from '../stores/branchPullRequestStore';
import type { DetailsTarget } from '../stores/workItemDetailsStore';

/**
 * The session's item: the one it is linked to, else one found from its
 * branch. A link is the person's own choice, so it always wins.
 */
export function sessionPullRequest(
  session: Session,
  found?: WorkItemRef,
): { ref: WorkItemRef; found: boolean } | null {
  if (session.workItem) return { ref: session.workItem, found: false };
  return found ? { ref: found, found: true } : null;
}

export type PullRequestSectionView =
  | { kind: 'hidden' }
  /** No account to read the item, or to look the branch up, with; the linked item when there is one. */
  | { kind: 'no-account'; ref?: WorkItemRef }
  /** No answer yet for the branch the checkout is on. */
  | { kind: 'looking' }
  /** The branch has no pull request. */
  | { kind: 'none' }
  | { kind: 'lookup-failed'; error: string }
  | { kind: 'item'; ref: WorkItemRef; found: boolean };

/**
 * What the section shows. A linked session shows its item, or says there is
 * no account to read it with. An unlinked one has something to show only
 * on a branch, where a pull request could be found from it: without an
 * account to look with, the section says so; with one, it follows the
 * lookup, whose answer counts only for the branch it was read for, so a
 * branch the checkout has just moved to reads as still being looked up.
 */
export function pullRequestSectionView({
  session,
  hasAccount,
  hasBranch,
  lookup,
  branch,
}: {
  session: Session;
  hasAccount: boolean;
  hasBranch: boolean;
  /** The branch's lookup, for an unlinked session. */
  lookup?: BranchPullRequestEntry;
  /** The branch the checkout is on. */
  branch?: string;
}): PullRequestSectionView {
  const linked = sessionPullRequest(session);
  if (linked) {
    return hasAccount ? { kind: 'item', ...linked } : { kind: 'no-account', ref: linked.ref };
  }
  if (!hasBranch) return { kind: 'hidden' };
  if (!hasAccount) return { kind: 'no-account' };
  const answer = lookup?.answer;
  if (!answer || !branch || answer.branch !== branch) return { kind: 'looking' };
  switch (answer.kind) {
    case 'none':
      return { kind: 'none' };
    case 'failed':
      return { kind: 'lookup-failed', error: answer.error };
    case 'found':
      return { kind: 'item', ref: answer.pullRequest.ref, found: true };
  }
}

/** The item's details as the workspace's account reads them; null without an account or an item. */
export function detailsTargetOf(
  workspace: Workspace,
  ref: WorkItemRef | undefined,
): DetailsTarget | null {
  if (!ref || !workspace.provider) return null;
  return { workspaceId: workspace.id, accountLogin: workspace.provider.accountLogin, ref };
}
