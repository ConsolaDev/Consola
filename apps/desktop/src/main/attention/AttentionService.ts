import type { Attention, AttentionChange, SnoozeView } from '../../shared/attention';
import type { AttentionSource } from './AttentionSource';

/** Changes inside this window go out as one broadcast. */
export const BROADCAST_MS = 100;

/**
 * The single place any main-side consumer asks what needs the person.
 *
 * Sources answer; this merges them, and pushes only what changed, coalesced.
 * Reads are always taken from the sources fresh, so the MCP tool and the
 * dock badge can never lag the sidebar by more than one broadcast.
 */
export class AttentionService {
  private readonly sources = new Map<AttentionSource, () => void>();
  private readonly listeners = new Set<(change: AttentionChange) => void>();
  /** What listeners were last told: the base the next diff is against. */
  private told = new Map<string, Attention>();
  /** The snooze views listeners were last told, diffed by value like `told`. */
  private toldSnoozes = new Map<string, SnoozeView>();
  private timer?: NodeJS.Timeout;

  /** Returns the unregister. */
  public register(source: AttentionSource): () => void {
    this.sources.set(
      source,
      source.subscribe(() => this.schedule()),
    );
    this.schedule();
    return () => {
      this.sources.get(source)?.();
      this.sources.delete(source);
      this.schedule();
    };
  }

  /** Every entry's current attention. */
  public snapshot(): Map<string, Attention> {
    const merged = new Map<string, Attention>();
    for (const source of this.sources.keys()) {
      for (const [key, attention] of source.read()) merged.set(key, attention);
    }
    return merged;
  }

  /** Every session's snooze view, from the same read as `attention` when the caller has one. */
  public snoozes(
    attention: ReadonlyMap<string, Attention> = this.snapshot(),
  ): Map<string, SnoozeView> {
    const merged = new Map<string, SnoozeView>();
    for (const source of this.sources.keys()) {
      for (const [key, view] of source.snoozes?.(attention) ?? []) merged.set(key, view);
    }
    return merged;
  }

  public get(entryKey: string): Attention | undefined {
    return this.snapshot().get(entryKey);
  }

  /** How many entries want the person right now. `done` never counts. */
  public needsAttentionCount(): number {
    let count = 0;
    for (const attention of this.snapshot().values()) if (attention === 'needs-attention') count++;
    return count;
  }

  /** Entries holding each session, across sources that say so. */
  public holds(): Map<string, string[]> {
    const merged = new Map<string, string[]>();
    for (const source of this.sources.keys()) {
      for (const [sessionId, keys] of source.holds?.() ?? []) {
        merged.set(sessionId, [...(merged.get(sessionId) ?? []), ...keys]);
      }
    }
    return merged;
  }

  /** Hear each coalesced change. Returns the unsubscribe. */
  public onChange(listener: (change: AttentionChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Send anything pending now. For quit and tests. */
  public flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;

    const current = this.snapshot();
    const change: AttentionChange = { changed: {}, removed: [] };
    for (const [key, attention] of current) {
      if (this.told.get(key) !== attention) change.changed[key] = attention;
    }
    for (const key of this.told.keys()) if (!current.has(key)) change.removed.push(key);
    this.told = current;

    // Snooze views ride the same broadcast, so a window never sees a row
    // move to the shelf without its countdown, or back without its mark.
    const snoozes = this.snoozes(current);
    const snoozeChanges: Record<string, SnoozeView | null> = {};
    for (const [key, view] of snoozes) {
      if (!sameView(this.toldSnoozes.get(key), view)) snoozeChanges[key] = view;
    }
    for (const key of this.toldSnoozes.keys()) if (!snoozes.has(key)) snoozeChanges[key] = null;
    this.toldSnoozes = snoozes;
    if (Object.keys(snoozeChanges).length > 0) change.snoozes = snoozeChanges;

    if (
      change.removed.length === 0 &&
      Object.keys(change.changed).length === 0 &&
      change.snoozes === undefined
    ) {
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error('An attention listener failed:', error);
      }
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), BROADCAST_MS);
    this.timer.unref?.();
  }
}

function sameView(a: SnoozeView | undefined, b: SnoozeView): boolean {
  return (
    a !== undefined &&
    a.until === b.until &&
    a.reason === b.reason &&
    a.wokeAt === b.wokeAt &&
    a.wakeCause === b.wakeCause
  );
}
