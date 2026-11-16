import type { Session } from './workspace';

/** One session's activity and shelving facts. Flat and row-shaped on purpose:
 *  this maps to a table unchanged if the store ever moves to SQL. */
export interface AttentionRecord {
  sessionId: string;
  workspaceId: string;
  lastActiveAt: number;
  finishedAt?: number; // written from slice 2 — define now, do not write
  seenAt?: number; // written from slice 2 — define now, do not write
  settledAt?: number; // written from slice 7 — define now, do not write
  settleHoldAt?: number; // written from slice 7 — define now, do not write
}

export type AttentionSnapshot = Record<string /* sessionId */, AttentionRecord>;

/** What a window reads when it opens: the ledger and, beside it, what main derives from it. A window
 *  opened after a status edge must agree with one that watched the edge happen. */
export interface AttentionState {
  records: AttentionSnapshot;
  attention: Record<string /* EntryKey */, Attention>;
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
  | 'needs-attention' | 'done' | 'working' | 'ready' | 'exited' | 'settled';

/** Higher wins. NOTE this inverts today's order: `exited` was the HIGHEST rank in
 *  renderer/utils/sessionStatus.ts and is now second lowest. */
export const RANK: Record<Attention, number> = {
  'needs-attention': 5, done: 4, working: 3, ready: 2, exited: 1, settled: 0,
};

/** The most urgent of a set. A fold over already-derived values — which is why it
 *  belongs in shared and `deriveAttention` does not. An empty set is `settled`: nothing asks for anything. */
export function worstStatus(values: Attention[]): Attention {
  return values.reduce<Attention>((worst, value) => (RANK[value] > RANK[worst] ? value : worst), 'settled');
}

/** What changed since the last `attention:changed`: new or updated entries, and entries that went away. */
export interface AttentionChange {
  changed: Record<string /* EntryKey */, Attention>;
  removed: string[];
}
