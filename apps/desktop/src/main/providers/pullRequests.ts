/**
 * Pull request state, provider-neutral.
 *
 * The Inbox only ever sees open items, so it cannot tell a merged PR from one
 * it simply cannot see. Anything that acts on "this PR is finished" — stale
 * session cleanup — asks the provider directly, by number for sessions that
 * are linked to a PR, or by head branch for sessions whose worktree pushed one.
 */

export type PullRequestQuery =
    | { repo: string; number: number }
    | { repo: string; headBranch: string };

export type PullRequestStatus = 'open' | 'merged' | 'closed';

export interface PullRequestState {
    number: number;
    status: PullRequestStatus;
    /** The PR's head commit as the provider last saw it — its final head once merged or closed. */
    headOid: string;
    headBranch: string;
    /**
     * A ref `git fetch origin <ref>` resolves to the PR's head even after its
     * branch is deleted — the provider's business (GitHub: `pull/<n>/head`).
     */
    fetchRef?: string;
    url: string;
    createdAt: string;
}

export interface PullRequestLookup {
    query: PullRequestQuery;
    /** Newest first; empty when nothing matched. */
    pullRequests: PullRequestState[];
    /** Set when this one query failed; the others still answer. */
    error?: string;
}
