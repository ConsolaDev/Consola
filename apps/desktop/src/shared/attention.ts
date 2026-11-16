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

/**
 * When a session was last genuinely active.
 *
 * Every reader goes through here: `Session.lastActiveAt` is only the
 * creation-time seed, so reading it directly sorts by creation date.
 */
export function activityOf(session: Session, record: AttentionRecord | undefined): number {
  return record?.lastActiveAt ?? session.lastActiveAt;
}
