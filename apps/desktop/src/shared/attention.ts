import type { Session } from './workspace';

/** One session's activity and shelving facts. Flat and row-shaped on purpose:
 *  this maps to a table unchanged if the store ever moves to SQL. */
export interface AttentionRecord {
  sessionId: string;
  workspaceId: string;
  lastActiveAt: number;
  /** When a turn last finished. */
  finishedAt?: number;
  /** When the person last saw the session. */
  seenAt?: number;
  /** When it went onto the Settled shelf, by hand or by auto-settle. */
  settledAt?: number;
  /** An explicit un-settle: holds auto-settle off until new activity. */
  settleHoldAt?: number;
  /** When it last came back from Settled, by hand or by new activity. Where a woken session lands in the list. */
  unsettledAt?: number;
  /** Parked until this instant. Only the Snoozer writes it, always with `snoozedAt`. */
  snoozedUntil?: number;
  /** When the snooze was written: a failure reported from before it is old news. */
  snoozedAt?: number;
  /** Why the snooze was written, when it was not the person's own choice of time. */
  snoozeReason?: SnoozeReason;
  /** When the session came back from a snooze by itself. Unseen until `seenAt` passes it. */
  wokeAt?: number;
  /** What brought it back. Written with `wokeAt`, only on a tree's root. */
  wakeCause?: WakeCause;
}

/** A snooze nobody picked a time for: the session stopped on a usage limit and waits for its reset. */
export type SnoozeReason = 'usage-limit';

/**
 * What ended a snooze, when the session came back on its own or an agent woke
 * it. The person's own wake leaves no cause: they know why.
 */
export type WakeCause = 'time' | 'limit-reset' | 'question' | 'failure' | 'limit' | 'agent';

/**
 * What a window needs to draw one session's snooze: the countdown while it is
 * parked, the Woke mark once it has come back and nobody has looked. Derived in
 * main beside attention, so two windows never disagree.
 */
export interface SnoozeView {
  /** While snoozed: when it comes back. */
  until?: number;
  reason?: SnoozeReason;
  /** It came back by itself and has not been looked at since. */
  wokeAt?: number;
  wakeCause?: WakeCause;
}

export type AttentionSnapshot = Record<string /* sessionId */, AttentionRecord>;

/** What a window reads when it opens: the ledger and, beside it, what main derives from it. A window
 *  opened after a status edge must agree with one that watched the edge happen. */
export interface AttentionState {
  records: AttentionSnapshot;
  attention: Record<string /* EntryKey */, Attention>;
  /** Sessions with a snooze running or an unseen wake. Absent means neither. */
  snoozes: Record<string /* sessionId */, SnoozeView>;
}

/**
 * When a session was last genuinely active.
 *
 * Every reader goes through here: `Session.lastActiveAt` is only the
 * creation-time seed, so reading it directly sorts by creation date.
 */
export function activityOf(session: Session, record: AttentionRecord | undefined): number {
  return record?.lastActiveAt ?? session.lastActiveAt;
}

/**
 * What a session (or, from slice 6, an open run) is asking of the person.
 * Derived once, in main, and only ever read elsewhere.
 */
export type Attention =
  | 'needs-attention'
  | 'snoozed'
  | 'done'
  | 'working'
  | 'ready'
  | 'exited'
  | 'settled';

/**
 * Higher wins. NOTE this inverts today's order: `exited` was the HIGHEST rank in
 * renderer/utils/sessionStatus.ts and is now second lowest.
 *
 * `snoozed` sits just under a question. Trees are placed by their worst member,
 * so anything lower would pull a snoozed conductor off the shelf the moment a
 * new child started working; a question still outranks it, and a snooze is
 * ended by the question before it could ever hide one.
 */
export const RANK: Record<Attention, number> = {
  'needs-attention': 6,
  snoozed: 5,
  done: 4,
  working: 3,
  ready: 2,
  exited: 1,
  settled: 0,
};

/** Put away, whether for good (settled) or until a time (snoozed): neither is in play. */
export function isParked(attention: Attention): boolean {
  return attention === 'snoozed' || attention === 'settled';
}

/** The most urgent of a set. A fold over already-derived values — which is why it
 *  belongs in shared and `deriveAttention` does not. An empty set has no answer (`undefined`): what empty means differs by caller, so each chooses. */
export function worstStatus(values: Attention[]): Attention | undefined {
  if (values.length === 0) return undefined;
  return values.reduce<Attention>(
    (worst, value) => (RANK[value] > RANK[worst] ? value : worst),
    values[0],
  );
}

/** What changed since the last `attention:changed`: new or updated entries, and entries that went away. */
export interface AttentionChange {
  changed: Record<string /* EntryKey */, Attention>;
  removed: string[];
  /** Snooze views that changed, by session id; null when a session no longer has one. Omitted when none did. */
  snoozes?: Record<string /* sessionId */, SnoozeView | null>;
}
