import type { AttentionRecord } from './attention';
import type { TerminalLinkRule } from './browser';
import { DEFAULT_WORKTREE_CLEANUP_RULES, type WorktreeCleanupRules } from './worktreeCleanup';
import { DEFAULT_SNOOZE_PRESETS, type SnoozePresetSetting } from './snooze';

/**
 * Preferences main itself has to read. The renderer's settings live in
 * localStorage, which main cannot see, and main is what runs the sweeper.
 */
export interface Preferences {
  /** Days idle before a session settles on its own. 0 turns auto-settle off. */
  autoSettleDays: number;
  /** The person has been told what auto-settle does. Once per install, not once per window. */
  hasExplainedAutoSettle: boolean;
  /**
   * Sessions auto-settle moved that the person has not yet been told about.
   * Held until they acknowledge, so an explanation that fires while no window
   * is open (or the app quits first) is still given on the next look.
   */
  pendingAutoSettle: string[];
  /** When a session's worktree is removed on its own. Every rule is off by default. */
  worktreeCleanup: WorktreeCleanupRules;
  /** The choices in every window's Snooze menu, in the order the person put them. Up to 8; may be empty. */
  snoozePresets: SnoozePresetSetting[];
  /** A session that stops on a usage limit snoozes itself until the limit resets. Off by default. */
  snoozeAtUsageLimit: boolean;
  /** Where a link clicked in a terminal opens. Shift does the opposite for one click. */
  terminalLinks: TerminalLinkRule;
}

/** Every rule a terminal link can follow, for validating what main reads or is sent. */
export const TERMINAL_LINK_RULES: readonly TerminalLinkRule[] = ['local', 'all', 'never'];

export function isTerminalLinkRule(value: unknown): value is TerminalLinkRule {
  return TERMINAL_LINK_RULES.some((rule) => rule === value);
}

/** On by default: old work leaves the list by itself, and says so the first time. */
export const DEFAULT_AUTO_SETTLE_DAYS = 7;

/** The thresholds offered in the UI. 0 is off. */
export const AUTO_SETTLE_CHOICES = [0, 1, 3, 7, 14, 30] as const;

export const DEFAULT_PREFERENCES: Preferences = {
  autoSettleDays: DEFAULT_AUTO_SETTLE_DAYS,
  hasExplainedAutoSettle: false,
  pendingAutoSettle: [],
  worktreeCleanup: DEFAULT_WORKTREE_CLEANUP_RULES,
  snoozePresets: [...DEFAULT_SNOOZE_PRESETS],
  snoozeAtUsageLimit: false,
  terminalLinks: 'local',
};

/**
 * What a manual settle did. `settled` is main's answer from the derivation, not
 * a hope: a session an open run holds never reads settled, whatever was written.
 * When it did not move the row nothing was kept, so there is nothing to undo.
 */
export interface SettleResult {
  settled: boolean;
  memento: SettleMemento;
}

/** What undoing a settle (or un-settle) restores: each session's ledger entry as it was, null for none. */
export type SettleMemento = Record<string /* sessionId */, AttentionRecord | null>;

/** Why one session of a batch was not acted on, in words a toast can show. */
export interface Refusal {
  sessionId: string;
  /** A stable code (`child`, `in-use`, `too-soon`, `not-snoozed`…), for callers that branch. */
  reason: string;
  message: string;
}

/**
 * What acting on several sessions at once did. One write, one memento, so one
 * Undo puts every session back. `applied` lists the sessions asked for that
 * were acted on; members carried along with a conductor are in the memento only.
 */
export interface BatchResult {
  applied: string[];
  refused: Refusal[];
  memento: SettleMemento;
}

/** A batch snooze, and the one time every applied session comes back at; null when they differ. */
export interface SnoozeBatchResult extends BatchResult {
  until: number | null;
}
