/**
 * Removing a session's worktree when its work is done: what the rules are,
 * what a decision about one worktree says, and the record a removal leaves.
 *
 * Shared because the renderer shows the rules and main's verdicts. Main writes
 * every sentence a verdict carries; the renderer never interprets a reason.
 */

/**
 * What asked for a worktree to go.
 *
 * - `pr-finished`, `settled`, `run-finished`: the sweep's rules. The session stays.
 * - `session-deleted`: a person deleted the session.
 * - `tool-stale`, `tool-delete`: Consola's cleanup tools (agents, automations).
 *   Those delete the session too.
 */
export type CleanupTrigger =
  | 'pr-finished'
  | 'session-deleted'
  | 'settled'
  | 'run-finished'
  | 'tool-stale'
  | 'tool-delete';

/** Why a worktree stays. Each comes with a sentence written in main. */
export type BlockerKind =
  /** Not one of Consola's own worktrees, or a clone's own checkout. */
  | 'not-managed'
  /** It is, or holds, a workspace folder. */
  | 'scope-folder'
  /** Someone chose "Never remove this worktree". */
  | 'opted-out'
  | 'conductor'
  /** A session on it is working or waiting on the person. */
  | 'busy'
  /** A session on it is open in a window. */
  | 'shown'
  /** An automation run is holding a session on it. */
  | 'held'
  /** A session on it was active within the quiet period. */
  | 'recent'
  /** Someone was just handed this folder to start a session in. */
  | 'recently-prepared'
  /** A process still runs inside the folder. */
  | 'process'
  | 'dirty'
  /** Commits that exist only here. */
  | 'unpublished'
  /** Commits that could not be confirmed as pushed. */
  | 'unverifiable'
  /** Ignored files with no identical copy in the main checkout. */
  | 'ignored-files'
  /** Skip-worktree or assume-unchanged files with edits. */
  | 'hidden-changes'
  | 'nested-repo'
  | 'locked'
  /** Another session that is not going still uses it. */
  | 'shared'
  /** No enabled rule applies to a session on it yet. */
  | 'not-due'
  /** A fact Consola could not read. */
  | 'unknown';

export interface Blocker {
  kind: BlockerKind;
  /** A sentence that reads after "Its worktree stays: ". */
  detail: string;
  /** The session the blocker is about, when it is about one. */
  sessionId?: string;
}

/** What happens to a worktree's branch when the worktree goes. */
export type BranchDisposal = 'keep' | 'delete-at-head';

/** The one decision about one worktree folder, shared by every caller. */
export type TreeVerdict =
  | {
      decision: 'remove';
      tree: string;
      sessionIds: string[];
      trigger: CleanupTrigger;
      branch: BranchDisposal;
    }
  | {
      decision: 'keep';
      tree: string;
      sessionIds: string[];
      /** The first is the headline. Never empty. */
      blockers: Blocker[];
    };

/**
 * A session's worktree that a rule removed while the session stayed.
 * Opening the session rebuilds it at `path`, on `commit`.
 */
export interface RemovedWorktree {
  path: string;
  /** The clone the worktree belonged to. */
  mainRepo: string;
  /** HEAD when it was removed. `keepRef` points at it, so gc cannot drop it. */
  commit: string;
  /** The branch it was on, or null for a detached HEAD. Kept for the rebuild. */
  branch: string | null;
  keepRef: string;
  trigger: CleanupTrigger;
  removedAt: number;
}

/** The ref a removal writes in the clone so the commit outlives the folder. */
export function keepRefFor(worktreePath: string): string {
  const name = worktreePath.split(/[\\/]/).filter(Boolean).pop() ?? 'worktree';
  return `refs/consola/worktrees/${name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '') || 'worktree'}`;
}

/**
 * The rules that remove a worktree on their own. Every one is off by
 * default. Deleting a session (`sessionDeleted`) is the one rule that also
 * deletes the session; the others leave it, to be rebuilt when opened.
 */
export interface WorktreeCleanupRules {
  /** Its pull request is merged or closed. */
  prFinished: boolean;
  /** You delete the session. */
  sessionDeleted: boolean;
  /** Days on the Settled shelf. 0 is off. */
  settledDays: number;
  /** Its automation run ended this long ago. */
  runFinished: { enabled: boolean; afterMinutes: number };
}

export const SETTLED_DAYS_CHOICES = [0, 1, 3, 7, 14, 30] as const;
export const RUN_FINISHED_MINUTES_CHOICES = [0, 15, 60, 240, 1440] as const;
export const DEFAULT_RUN_FINISHED_MINUTES = 60;

export const DEFAULT_WORKTREE_CLEANUP_RULES: WorktreeCleanupRules = {
  prFinished: false,
  sessionDeleted: false,
  settledDays: 0,
  runFinished: { enabled: false, afterMinutes: DEFAULT_RUN_FINISHED_MINUTES },
};

/** Whether any rule would ever remove anything. */
export function anyRuleOn(rules: WorktreeCleanupRules | null): boolean {
  return (
    !!rules &&
    (rules.prFinished || rules.sessionDeleted || rules.settledDays > 0 || rules.runFinished.enabled)
  );
}

/**
 * A rules value read from anywhere — a file, an IPC payload — rebuilt from
 * known keys, each falling back on its own. Never spread.
 */
export function normalizeRules(
  value: unknown,
  fallback = DEFAULT_WORKTREE_CLEANUP_RULES,
): WorktreeCleanupRules {
  const row = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const run = (
    typeof row.runFinished === 'object' && row.runFinished !== null ? row.runFinished : {}
  ) as Record<string, unknown>;
  const days = row.settledDays;
  const minutes = run.afterMinutes;
  return {
    prFinished: typeof row.prFinished === 'boolean' ? row.prFinished : fallback.prFinished,
    sessionDeleted:
      typeof row.sessionDeleted === 'boolean' ? row.sessionDeleted : fallback.sessionDeleted,
    settledDays:
      typeof days === 'number' && Number.isFinite(days) && days >= 0
        ? Math.floor(days)
        : fallback.settledDays,
    runFinished: {
      enabled: typeof run.enabled === 'boolean' ? run.enabled : fallback.runFinished.enabled,
      afterMinutes:
        typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0
          ? Math.floor(minutes)
          : fallback.runFinished.afterMinutes,
    },
  };
}

/**
 * A workspace's own answer: off, or its own rules. Absent means it inherits
 * the global rules (`Preferences.worktreeCleanup`).
 */
export type WorkspaceWorktreeCleanup =
  | { mode: 'off' }
  | { mode: 'custom'; rules: WorktreeCleanupRules };

/**
 * The rules that apply in a workspace: its own when it has them, none when
 * it is off, else the global ones. No IO; main and the renderer share it.
 */
export function effectiveWorktreeCleanup(
  global: WorktreeCleanupRules,
  override: WorkspaceWorktreeCleanup | undefined,
): WorktreeCleanupRules | null {
  if (!override) return global;
  if (override.mode === 'off') return null;
  return override.rules;
}

/** A workspace override from anywhere, rebuilt from known keys. Throws on a shape that is not one. */
export function normalizeWorkspaceOverride(value: unknown): WorkspaceWorktreeCleanup {
  const row = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (row.mode === 'off') return { mode: 'off' };
  if (row.mode === 'custom') return { mode: 'custom', rules: normalizeRules(row.rules) };
  throw new Error('Choose Inherit, Off or Custom for worktree cleanup.');
}

/** Whether any rule that runs on its own (not on delete) is on. */
export function anySweepRuleOn(rules: WorktreeCleanupRules | null): boolean {
  return !!rules && (rules.prFinished || rules.settledDays > 0 || rules.runFinished.enabled);
}

/** One worktree in a preview or a run's report. Every sentence is main's. */
export interface CleanupEntry {
  tree: string;
  sessions: Array<{ id: string; name: string; workspaceId: string }>;
  decision: 'remove' | 'keep';
  /** Remove: why it qualifies. Keep: why it stays. */
  reason: string;
  trigger?: CleanupTrigger;
}

export interface CleanupPreview {
  /** Worktrees that would go now, then those that stay, each with why. */
  entries: CleanupEntry[];
  removable: number;
  summary: string;
}

export interface CleanupReport {
  removed: CleanupEntry[];
  kept: CleanupEntry[];
  failed: Array<CleanupEntry & { error: string }>;
  summary: string;
}

/** A line in the cleanup history. */
export interface CleanupHistoryEntry {
  id: string;
  at: number;
  action: 'removed' | 'rebuilt';
  tree: string;
  sessionNames: string[];
  workspaceIds: string[];
  trigger?: CleanupTrigger;
  /** For a removal: what happened to its branch. */
  branch?: 'deleted' | 'kept' | 'none';
  /** One sentence for the list. */
  detail: string;
}

/** Why a worktree qualifies, as a sentence. */
export function describeTrigger(trigger: CleanupTrigger): string {
  switch (trigger) {
    case 'pr-finished':
      return 'Its pull request is finished';
    case 'settled':
      return 'It has been settled long enough';
    case 'run-finished':
      return 'Its automation run ended';
    case 'session-deleted':
      return 'Its session was deleted';
    case 'tool-stale':
    case 'tool-delete':
      return 'A cleanup tool removed it';
  }
}

/**
 * What a preview is asked about: one workspace or all, judged by the stored
 * rules or by rules the person is about to choose (confirm-on-enable).
 */
export interface CleanupPreviewRequest {
  workspaceId?: string;
  /** Global rules to judge by instead of the stored ones. */
  global?: WorktreeCleanupRules;
  /** A workspace override to judge by instead of its stored one; null is Inherit. */
  override?: { workspaceId: string; value: WorkspaceWorktreeCleanup | null };
}

/** What deleting a session will do to its worktree, as main's sentence; null when nothing beyond today's delete. */
export interface SessionDeletePreview {
  worktree: string | null;
}

/**
 * What deleting a session did. `removing` means the record is gone and the
 * worktree is on its way: the final word arrives as its own event.
 */
export interface SessionDeleteOutcome {
  worktree: 'removed' | 'removing' | 'kept' | 'none';
  branch: 'deleted' | 'kept' | 'none';
  /** A sentence for a toast; absent when the delete was just a delete. */
  message?: string;
}
