/**
 * How much a page may send an agent's connection to it, with no IO.
 *
 * While an agent is connected, everything the page's debugger emits reaches
 * main: Electron parses each event on main's thread, whoever reads it after.
 * The page decides how much that is (it can log a 20 MB string in a loop, or
 * open requests as fast as it likes), so each connection has a budget, in
 * events and in their size, and a page that runs it out costs the agent its
 * connection rather than the app its memory or its responsiveness. Closing
 * the connection detaches the debugger, which stops the stream at its source.
 *
 * Each budget is a bucket that fills back at a steady rate: a burst (a
 * page's first load, the replay Chromium sends when a domain is enabled)
 * spends what has built up, and only a page that keeps sending more than the
 * steady rate empties it.
 */

const MB = 1024 * 1024;

/** Events: a busy page sends a few hundred a second, a page's load a few thousand at once. */
export const EVENT_BUDGET = { burst: 20_000, perSecond: 5000 } as const;
/** Their size, in characters: a page's load, or a busy feed, stays well inside it. */
export const BYTE_BUDGET = { burst: 64 * MB, perSecond: 16 * MB } as const;

export const TOO_MANY_EVENTS_MESSAGE =
  'The page sent events faster than an agent’s connection to it may carry, so the connection was closed.';
export const TOO_MANY_BYTES_MESSAGE =
  'The page sent more data than an agent’s connection to it may carry, so the connection was closed.';

/** What an event counts for besides its strings: a key, a number, a bracket. */
const PART_SIZE = 8;
/** The most parts one event is walked through; one with more counts as at least the cap. */
const MAX_PARTS = 100_000;

/**
 * About how large a parsed event is, in characters: every string's length
 * and a little for every other part. Counting stops at `cap`, and so does
 * the walk, so a huge event costs no more to measure than the cap allows.
 */
export function approximateSize(value: unknown, cap: number): number {
  let size = 0;
  let parts = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    if (size >= cap || parts >= MAX_PARTS) return cap;
    const part = pending.pop();
    parts += 1;
    if (typeof part === 'string') {
      size += part.length;
    } else if (Array.isArray(part)) {
      size += PART_SIZE;
      for (const item of part) pending.push(item);
    } else if (typeof part === 'object' && part !== null) {
      size += PART_SIZE;
      for (const [key, item] of Object.entries(part)) {
        size += key.length;
        pending.push(item);
      }
    } else {
      size += PART_SIZE;
    }
  }
  return Math.min(size, cap);
}

/** One bucket: `burst` at most, filling back at `perSecond`. */
class Allowance {
  private level: number;
  private at: number;

  constructor(
    private readonly limits: { burst: number; perSecond: number },
    now: number,
  ) {
    this.level = limits.burst;
    this.at = now;
  }

  /** Spends `amount`; false once the bucket is overdrawn. */
  public spend(amount: number, now: number): boolean {
    // A clock that went backwards gives nothing back.
    const elapsed = Math.max(0, now - this.at);
    this.at = Math.max(this.at, now);
    this.level = Math.min(this.limits.burst, this.level + (elapsed * this.limits.perSecond) / 1000);
    this.level -= amount;
    return this.level >= 0;
  }
}

/** One connection's budget. */
export class EventBudget {
  private readonly events: Allowance;
  private readonly bytes: Allowance;

  constructor(private readonly now: () => number = Date.now) {
    const start = now();
    this.events = new Allowance(EVENT_BUDGET, start);
    this.bytes = new Allowance(BYTE_BUDGET, start);
  }

  /** Counts one event; why the connection must close once the budget is spent, else null. */
  public spend(params: unknown): string | null {
    const at = this.now();
    if (!this.events.spend(1, at)) return TOO_MANY_EVENTS_MESSAGE;
    // Measured only up to what could still be allowed: one past the burst is over either way.
    if (!this.bytes.spend(approximateSize(params, BYTE_BUDGET.burst + 1), at)) {
      return TOO_MANY_BYTES_MESSAGE;
    }
    return null;
  }
}
