/**
 * What stale-session cleanup reports: to agents (MCP tool results), to run
 * history, and to the Automations dashboard, which renders previews and results
 * from these shapes.
 */

export type StalePrStatus = 'merged' | 'closed';

export type CleanupSkipReason =
    | 'caller'
    | 'conductor'
    | 'assistant'
    | 'busy'
    | 'no-provider'
    | 'not-linked'
    | 'lookup-failed'
    | 'no-pr'
    | 'pr-open'
    | 'pr-state-excluded'
    | 'not-managed-worktree'
    | 'dirty'
    | 'local-commits'
    | 'unverifiable';

export interface PullRequestSummary {
    repo: string;
    number: number;
    status: 'open' | 'merged' | 'closed';
    url: string;
}

/** One session considered: going (in `candidates`) or kept (in `skipped`, with a reason). */
export interface SessionVerdict {
    sessionId: string;
    sessionName: string;
    workspaceId: string;
    workspaceName: string;
    reason?: CleanupSkipReason;
    detail?: string;
    pullRequest?: PullRequestSummary;
    /** What happens on disk. Absent when the session has no worktree left to touch. */
    worktree?: { path: string; remove: boolean; keptBecause?: string };
    /** Deleted together with the worktree. */
    branch?: string;
}

export interface StalePreview {
    candidates: SessionVerdict[];
    skipped: SessionVerdict[];
    /** Requested ids that name no session the caller can see. */
    unknownSessionIds: string[];
    summary: string;
}

export interface SessionOutcome {
    sessionId: string;
    sessionName: string;
    workspaceName: string;
    pullRequest?: PullRequestSummary;
    worktree: 'removed' | 'kept' | 'none';
    branch: 'deleted' | 'kept' | 'none';
    notes: string[];
    error?: string;
}

export interface CleanupResult {
    removed: SessionOutcome[];
    failed: SessionOutcome[];
    skipped: SessionVerdict[];
    unknownSessionIds: string[];
    summary: string;
}
