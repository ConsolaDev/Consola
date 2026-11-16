import type { AttentionRecord, AttentionSnapshot } from '../../shared/attention';
import { JsonStateFile } from '../state/JsonStateFile';

/**
 * Where each session was last active.
 *
 * A port: everything else talks to this interface, so the JSON file below can
 * be swapped for a real store without touching a caller. Reads are
 * query-shaped (ask for the sessions you know) rather than "hand me
 * everything and filter", which is what a SQL backend would have to rewrite.
 */
export interface AttentionLedger {
  /** Record activity. Debounced internally; safe to call on every turn edge. */
  touch(sessionId: string, workspaceId: string, at: number): void;
  /** A turn settled: the work is done, whether or not anyone has looked. */
  markFinished(sessionId: string, workspaceId: string, at: number): void;
  /** The person saw the session. Nothing to mark for a session the ledger has never heard of. */
  markSeen(sessionId: string, at: number): void;
  get(sessionId: string): AttentionRecord | undefined;
  /** Query-shaped read for a known set. */
  activityFor(sessionIds: string[]): Map<string, number>;
  /** The ONE bulk read, for the IPC snapshot. Do not use it internally. */
  snapshot(): AttentionSnapshot;
  /** Drop records whose session no longer exists. */
  prune(liveSessionIds: Set<string>): void;
  /** Flush any debounced write. Call on quit. */
  flush(): void;
}

/** The on-disk shape: one flat row per session id. */
export interface AttentionLedgerStateFile {
  records: Record<string, AttentionRecord>;
}

/** At most one disk write per session in this window. */
export const WRITE_INTERVAL_MS = 30_000;

/** Read a stored row as a record, or null when it is malformed. */
function normalizeRecord(value: unknown): AttentionRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.sessionId !== 'string' || typeof row.workspaceId !== 'string') return null;
  if (typeof row.lastActiveAt !== 'number' || !Number.isFinite(row.lastActiveAt)) return null;
  const record: AttentionRecord = {
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    lastActiveAt: row.lastActiveAt,
  };
  for (const key of ['finishedAt', 'seenAt', 'settledAt', 'settleHoldAt'] as const) {
    const field = row[key];
    if (typeof field === 'number' && Number.isFinite(field)) record[key] = field;
  }
  return record;
}

/**
 * The ledger as a JSON sidecar, for the same reason `ViewMemoryService` is
 * one: a turn ending must not cost a synchronous fsync of the whole workspace
 * list and a broadcast to every window.
 *
 * Memory is authoritative. A turn edge can arrive every few seconds, so a
 * session's write is deferred until 30 seconds after its last one; a touch
 * inside that window only marks it dirty and a timer persists it when due.
 */
export class JsonAttentionLedger implements AttentionLedger {
  private records = new Map<string, AttentionRecord>();
  private readonly lastPersistedAt = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly file: JsonStateFile<AttentionLedgerStateFile>) {}

  /**
   * Read the file, skipping anything malformed. Never throws: a lost ledger
   * costs a quiet restart (sessions fall back to their creation time), not
   * the app.
   */
  public load(): void {
    let stored: { records?: unknown } | null = null;
    try {
      stored = this.file.read() as { records?: unknown } | null;
    } catch (error) {
      console.error('Could not read the attention ledger; starting empty.', error);
      return;
    }
    const rows = stored?.records;
    if (typeof rows !== 'object' || rows === null) return;
    for (const entry of Object.values(rows)) {
      const record = normalizeRecord(entry);
      if (record) this.records.set(record.sessionId, record);
    }
  }

  public touch(sessionId: string, workspaceId: string, at: number): void {
    const current = this.records.get(sessionId);
    // Activity never moves backwards: a late edge must not age a session.
    const lastActiveAt = Math.max(at, current?.lastActiveAt ?? at);
    this.commit({ ...current, sessionId, workspaceId, lastActiveAt });
  }

  public markFinished(sessionId: string, workspaceId: string, at: number): void {
    const current = this.records.get(sessionId);
    this.commit({
      ...current,
      sessionId,
      workspaceId,
      lastActiveAt: current?.lastActiveAt ?? at,
      finishedAt: Math.max(at, current?.finishedAt ?? at),
    });
  }

  public markSeen(sessionId: string, at: number): void {
    const current = this.records.get(sessionId);
    if (!current) return;
    this.commit({ ...current, seenAt: Math.max(at, current.seenAt ?? at) });
  }

  /** Store a changed record and schedule its write. */
  private commit(record: AttentionRecord): void {
    const { sessionId } = record;
    this.records.set(sessionId, record);
    this.dirty.add(sessionId);

    if (this.timers.has(sessionId)) return;
    const due = (this.lastPersistedAt.get(sessionId) ?? -Infinity) + WRITE_INTERVAL_MS;
    const wait = due - Date.now();
    if (wait <= 0) {
      this.persist();
      return;
    }
    const timer = setTimeout(() => this.persist(), wait);
    // A pending write must not keep the process alive; quit calls flush().
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  public get(sessionId: string): AttentionRecord | undefined {
    return this.records.get(sessionId);
  }

  public activityFor(sessionIds: string[]): Map<string, number> {
    const found = new Map<string, number>();
    for (const sessionId of sessionIds) {
      const record = this.records.get(sessionId);
      if (record) found.set(sessionId, record.lastActiveAt);
    }
    return found;
  }

  public snapshot(): AttentionSnapshot {
    return Object.fromEntries(this.records);
  }

  public prune(liveSessionIds: Set<string>): void {
    let removed = false;
    for (const sessionId of [...this.records.keys()]) {
      if (liveSessionIds.has(sessionId)) continue;
      this.records.delete(sessionId);
      this.lastPersistedAt.delete(sessionId);
      this.dirty.delete(sessionId);
      this.clearTimer(sessionId);
      removed = true;
    }
    if (removed) this.persist();
  }

  public flush(): void {
    if (this.dirty.size > 0) this.persist();
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  /** Write everything; every dirty session starts a fresh interval. */
  private persist(): void {
    const now = Date.now();
    for (const sessionId of this.dirty) {
      this.lastPersistedAt.set(sessionId, now);
      this.clearTimer(sessionId);
    }
    this.dirty.clear();
    try {
      this.file.write({ records: Object.fromEntries(this.records) });
    } catch (error) {
      // Memory stays authoritative; the next write retries with everything.
      console.error('Could not write the attention ledger.', error);
    }
  }
}
