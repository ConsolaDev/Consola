import type { AttentionRecord } from './attention';

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
}

/** On by default: old work leaves the list by itself, and says so the first time. */
export const DEFAULT_AUTO_SETTLE_DAYS = 7;

/** The thresholds offered in the UI. 0 is off. */
export const AUTO_SETTLE_CHOICES = [0, 1, 3, 7, 14, 30] as const;

export const DEFAULT_PREFERENCES: Preferences = {
  autoSettleDays: DEFAULT_AUTO_SETTLE_DAYS,
  hasExplainedAutoSettle: false,
  pendingAutoSettle: [],
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
