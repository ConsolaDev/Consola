import type {
  AttentionRecord,
  AttentionSnapshot,
  SnoozeReason,
  WakeCause,
} from '../../shared/attention';
import type { SettleMemento } from '../../shared/preferences';
import type { JsonStateFile } from '../state/JsonStateFile';

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
  /** The session launched: a finish belongs to the lifetime it happened in, so the last one is history. */
  clearFinished(sessionId: string): void;
  /** The person saw the session. Nothing to mark for a session the ledger has never heard of. */
  markSeen(sessionId: string, at: number): void;
  /**
   * Shelve sessions. `markSeen` is for the person's own decision to settle:
   * deciding it is finished with is having seen it. One write for the batch.
   * Returns the entries as they were, for `restore`.
   */
  settle(targets: SettleTarget[], at: number, options: { markSeen: boolean }): SettleMemento;
  /**
   * The person brought sessions back. Holds auto-settle off until the session
   * has new activity, or the sweep would re-hide what was just recovered.
   */
  unsettle(sessionIds: string[], at: number): SettleMemento;
  /**
   * Park sessions until `until`, in one write. Clears settled (one shelf at a
   * time) and any earlier wake. Only the Snoozer calls this.
   */
  snooze(targets: SnoozeTarget[], at: number, reason?: SnoozeReason): SnoozeMemento;
  /**
   * End sessions' snoozes, in one write. Each records when it came back
   * (`wokeAt`, where the list places it). `marks` names the ones that came
   * back without the person (a tree's root) and why: only those read as news.
   * `hold` says the person brought them back, so auto-settle leaves them
   * alone until new activity, as it does after an un-settle. Only the
   * Snoozer calls this.
   */
  wake(
    sessionIds: string[],
    at: number,
    options?: { marks?: Record<string, WakeCause>; hold?: boolean },
  ): SettleMemento;
  /** Every record with a snooze, soonest wake first. */
  snoozed(): AttentionRecord[];
  /**
   * Undo a settle, un-settle, snooze or wake: put back only the fields those
   * write (`seenAt` and the shelving fields), never activity. A snoozed
   * session keeps working, so restoring a whole record would erase a finish
   * written in between. An entry recorded as null had no record: its shelving
   * fields are stripped, and whatever activity it gained since is kept.
   */
  restore(memento: SettleMemento): void;
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

/** A session to shelve, with what the ledger needs if it has never heard of it. */
export interface SettleTarget {
  sessionId: string;
  workspaceId: string;
  /** Its activity when the ledger has no record: the session's creation-time seed. */
  activityAt: number;
}

/** A session to snooze, and when it comes back. */
export interface SnoozeTarget extends SettleTarget {
  until: number;
}

/** What a snooze recorded, for `restore`: the same shape as a settle's. */
export type SnoozeMemento = SettleMemento;

/** The fields shelving writes, and so the only ones an undo puts back. */
const SHELVING_FIELDS = [
  'seenAt',
  'settledAt',
  'settleHoldAt',
  'unsettledAt',
  'snoozedUntil',
  'snoozedAt',
  'snoozeReason',
  'wokeAt',
  'wakeCause',
] as const;

const SNOOZE_REASONS: ReadonlySet<SnoozeReason> = new Set<SnoozeReason>(['usage-limit']);
const WAKE_CAUSES: ReadonlySet<WakeCause> = new Set<WakeCause>([
  'time',
  'limit-reset',
  'question',
  'failure',
  'limit',
  'agent',
]);

/** A record without its snooze. */
function withoutSnooze(record: AttentionRecord): AttentionRecord {
  const { snoozedUntil: _until, snoozedAt: _at, snoozeReason: _reason, ...rest } = record;
  return rest;
}

/**
 * Whether a record shelving created has seen anything since: a finish, or
 * activity after the write (a settle is never earlier than the activity it
 * read; a snooze is written when it was asked for).
 */
function hasActivitySince(record: AttentionRecord): boolean {
  if (record.finishedAt !== undefined) return true;
  const written = record.settledAt ?? record.snoozedAt ?? record.wokeAt;
  return written === undefined || record.lastActiveAt > written;
}

/** The on-disk shape: one flat row per session id. */
export interface AttentionLedgerStateFile {
  records: Record<string, AttentionRecord>;
}

/** At most one disk write per session in this window. */
export const WRITE_INTERVAL_MS = 30_000;

/** Whether a record reads as put away: settled no earlier than its last activity, as deriveAttention reads it. */
const isShelved = (record: AttentionRecord): boolean =>
  record.settledAt !== undefined && record.settledAt >= record.lastActiveAt;

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
  for (const key of [
    'finishedAt',
    'seenAt',
    'settledAt',
    'settleHoldAt',
    'unsettledAt',
    'snoozedUntil',
    'snoozedAt',
    'wokeAt',
  ] as const) {
    const field = row[key];
    if (typeof field === 'number' && Number.isFinite(field)) record[key] = field;
  }
  // A snooze is written whole. Half of one cannot be honoured: with no time it
  // never ends, and with no start every failure would read as news.
  if ((record.snoozedUntil === undefined) !== (record.snoozedAt === undefined)) {
    delete record.snoozedUntil;
    delete record.snoozedAt;
  }
  if (record.snoozedUntil !== undefined && SNOOZE_REASONS.has(row.snoozeReason as SnoozeReason))
    record.snoozeReason = row.snoozeReason as SnoozeReason;
  if (record.wokeAt !== undefined && WAKE_CAUSES.has(row.wakeCause as WakeCause))
    record.wakeCause = row.wakeCause as WakeCause;
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
      stored = this.file.read();
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
    const next: AttentionRecord = { ...current, sessionId, workspaceId, lastActiveAt };
    // Activity after a settle is what takes a session off the shelf (see
    // deriveAttention), so this is the moment it came back. A late edge that
    // lands before the settle leaves it where it was.
    if (current && isShelved(current) && lastActiveAt > current.settledAt!)
      next.unsettledAt = lastActiveAt;
    this.commit(next);
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

  public clearFinished(sessionId: string): void {
    const current = this.records.get(sessionId);
    if (current?.finishedAt === undefined) return;
    const { finishedAt: _gone, ...rest } = current;
    this.commit(rest);
  }

  public markSeen(sessionId: string, at: number): void {
    const current = this.records.get(sessionId);
    if (!current) return;
    this.commit({ ...current, seenAt: Math.max(at, current.seenAt ?? at) });
  }

  /** Store a changed record and schedule its write. */
  private commit(record: AttentionRecord): void {
    if (this.stage(record)) this.persist();
  }

  /** Several records, one write. */
  private commitAll(records: AttentionRecord[]): void {
    let due = false;
    for (const record of records) due = this.stage(record) || due;
    if (due) this.persist();
  }

  /** Keep a record in memory and arrange its write. True when the write is due now. */
  private stage(record: AttentionRecord): boolean {
    const { sessionId } = record;
    this.records.set(sessionId, record);
    this.dirty.add(sessionId);

    if (this.timers.has(sessionId)) return false;
    const due = (this.lastPersistedAt.get(sessionId) ?? -Infinity) + WRITE_INTERVAL_MS;
    const wait = due - Date.now();
    if (wait <= 0) return true;
    const timer = setTimeout(() => this.persist(), wait);
    // A pending write must not keep the process alive; quit calls flush().
    timer.unref?.();
    this.timers.set(sessionId, timer);
    return false;
  }

  public settle(
    targets: SettleTarget[],
    at: number,
    { markSeen }: { markSeen: boolean },
  ): SettleMemento {
    const memento: SettleMemento = {};
    const next: AttentionRecord[] = [];
    for (const { sessionId, workspaceId, activityAt } of targets) {
      const current = this.records.get(sessionId);
      memento[sessionId] = current ? { ...current } : null;
      const lastActiveAt = current?.lastActiveAt ?? activityAt;
      const settled: AttentionRecord = {
        // One shelf at a time: settling ends a snooze.
        ...(current ? withoutSnooze(current) : undefined),
        sessionId,
        workspaceId: current?.workspaceId ?? workspaceId,
        lastActiveAt,
        // Never earlier than the last activity, or it would not read as settled.
        settledAt: Math.max(at, lastActiveAt),
      };
      if (markSeen) settled.seenAt = Math.max(at, current?.seenAt ?? at);
      next.push(settled);
    }
    this.commitAll(next);
    return memento;
  }

  public unsettle(sessionIds: string[], at: number): SettleMemento {
    const memento: SettleMemento = {};
    const next: AttentionRecord[] = [];
    for (const sessionId of sessionIds) {
      const current = this.records.get(sessionId);
      if (!current) continue;
      memento[sessionId] = { ...current };
      const { settledAt: _gone, ...rest } = current;
      next.push({ ...rest, settleHoldAt: at, unsettledAt: at });
    }
    this.commitAll(next);
    return memento;
  }

  public snooze(targets: SnoozeTarget[], at: number, reason?: SnoozeReason): SnoozeMemento {
    const memento: SnoozeMemento = {};
    const next: AttentionRecord[] = [];
    for (const { sessionId, workspaceId, activityAt, until } of targets) {
      const current = this.records.get(sessionId);
      memento[sessionId] = current ? { ...current } : null;
      const {
        settledAt: _settled,
        wokeAt: _woke,
        wakeCause: _cause,
        ...rest
      } = current ? withoutSnooze(current) : ({} as Partial<AttentionRecord>);
      next.push({
        ...rest,
        sessionId,
        workspaceId: current?.workspaceId ?? workspaceId,
        lastActiveAt: current?.lastActiveAt ?? activityAt,
        snoozedUntil: until,
        snoozedAt: at,
        ...(reason ? { snoozeReason: reason } : {}),
      });
    }
    this.commitAll(next);
    return memento;
  }

  public wake(
    sessionIds: string[],
    at: number,
    options: { marks?: Record<string, WakeCause>; hold?: boolean } = {},
  ): SettleMemento {
    const memento: SettleMemento = {};
    const next: AttentionRecord[] = [];
    for (const sessionId of sessionIds) {
      const current = this.records.get(sessionId);
      if (!current) continue;
      memento[sessionId] = { ...current };
      const woken = withoutSnooze(current);
      // When it came back places it in the list; only a mark says it is news.
      woken.wokeAt = at;
      delete woken.wakeCause;
      const cause = options.marks?.[sessionId];
      if (cause) woken.wakeCause = cause;
      if (options.hold) woken.settleHoldAt = at;
      next.push(woken);
    }
    this.commitAll(next);
    return memento;
  }

  public snoozed(): AttentionRecord[] {
    return [...this.records.values()]
      .filter((record) => record.snoozedUntil !== undefined)
      .sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0));
  }

  public restore(memento: SettleMemento): void {
    const next: AttentionRecord[] = [];
    let removed = false;
    for (const [sessionId, previous] of Object.entries(memento)) {
      const current = this.records.get(sessionId);
      // A memento crosses IPC: trust its shape no further than a file on disk.
      const recorded = previous === null ? null : normalizeRecord(previous);
      if (previous !== null && (!recorded || recorded.sessionId !== sessionId)) continue;
      if (!current) {
        // Gone since (or never had activity): nothing to keep, so the recorded row returns whole.
        if (recorded) next.push(recorded);
        continue;
      }
      if (!recorded && !hasActivitySince(current)) {
        // The action made this record and nothing has happened since: the
        // session goes back to having none, exactly as it was.
        this.records.delete(sessionId);
        removed = true;
        continue;
      }
      const restored: AttentionRecord = { ...current };
      for (const field of SHELVING_FIELDS) delete restored[field];
      if (recorded) {
        for (const field of SHELVING_FIELDS) {
          if (recorded[field] !== undefined) Object.assign(restored, { [field]: recorded[field] });
        }
      }
      next.push(restored);
    }
    this.commitAll(next);
    // A deleted record has nothing to mark dirty: write it out now.
    if (removed) this.persist();
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
