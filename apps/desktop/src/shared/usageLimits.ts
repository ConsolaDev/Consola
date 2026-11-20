/**
 * A harness's usage limits, as its own CLI reports them, and the one rule that
 * reads them for every CLI.
 *
 * Each driver turns its CLI's answer into windows; nothing here knows which CLI
 * answered. The rule never guesses a reset time: a window that is used up but
 * carries no time leaves the whole answer without one, because waking a session
 * before its limit resets only stops it again.
 */

/** One allowance the CLI counts against: a five-hour session, a week, a month. */
export interface UsageWindow {
  /** Stable within one driver's answers, so one window can be followed across reads. */
  id: string;
  kind: 'session' | 'weekly' | 'monthly' | 'other';
  /** 0..100, as the CLI reports it; 100 or more is used up. */
  usedPercent: number;
  /** Epoch ms. Absent when the CLI gave no time, or one that could not be read. */
  resetsAt?: number;
  /**
   * The model this window counts, by the CLI's own name for it ("Opus").
   * Absent for a window every model counts against.
   */
  model?: string;
}

/**
 * What a harness's CLI said about its limits. `available: false` is a login
 * the CLI keeps no limits for: an API key, or nobody signed in.
 */
export type HarnessLimits =
  | { available: false }
  | { available: true; checkedAt: number; windows: UsageWindow[] };

/** Why a session stopped on a limit, and when it may go on. */
export interface SessionUsageLimit {
  stoppedAt: number;
  /** Absent when no used-up window that binds the session carried a time. */
  resetsAt?: number;
  /** What said it stopped: a hook the CLI posted, or its notice on screen. */
  signal: 'hook' | 'notice';
  /** The binding window's id, when one was found. */
  window?: string;
}

export interface UsageLimitsState {
  sessions: Record<string /* sessionId */, SessionUsageLimit>;
  /** Only harnesses limited for every model, keyed by harness id. */
  harnesses: Record<string /* harnessId */, { resetsAt: number }>;
}

/**
 * A reset further ahead than this is not a usage window's. No CLI's window is
 * longer than a month, so a time beyond it is a misread (seconds taken for
 * milliseconds, a date from another field), not a time to wait for.
 */
const MAX_RESET_AHEAD_MS = 31 * 24 * 60 * 60 * 1000;

/** Lower case, with every run of punctuation and spaces folded to one `_`. */
function foldName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasTime(window: UsageWindow): window is UsageWindow & { resetsAt: number } {
  return typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt);
}

/** Used up: at or past 100%, and not yet reset — or with no time to say it has. */
function isUsedUp(window: UsageWindow, now: number): boolean {
  if (!(window.usedPercent >= 100)) return false;
  return !hasTime(window) || window.resetsAt > now;
}

/**
 * Whether a window counts against a session on `model`, the session's model
 * selector. A window for one model binds a session only when the selector
 * names that model ("claude-opus-4-1" for "Opus"); a session with no model set
 * runs on whatever the CLI defaults to, which a scoped window cannot be said
 * to bind.
 */
function binds(window: UsageWindow, model: string | undefined): boolean {
  if (window.model === undefined) return true;
  if (!model) return false;
  const scope = foldName(window.model);
  return scope !== '' && foldName(model).includes(scope);
}

/**
 * The latest reset among `windows`, or undefined when any of them has none —
 * a session waits for every window that stopped it. A time not after `after`,
 * or more than a month ahead of `now`, is no reset to wait for.
 */
function latestReset(
  windows: readonly UsageWindow[],
  { now, after }: { now: number; after: number },
): number | undefined {
  if (windows.length === 0) return undefined;
  let latest = Number.NEGATIVE_INFINITY;
  for (const window of windows) {
    if (!hasTime(window)) return undefined;
    latest = Math.max(latest, window.resetsAt);
  }
  if (latest <= after || latest > now + MAX_RESET_AHEAD_MS) return undefined;
  return latest;
}

/** The used-up windows that bind a session on `model`. */
export function exhaustedWindows(
  limits: HarnessLimits,
  at: { now: number; model?: string },
): UsageWindow[] {
  if (!limits.available) return [];
  return limits.windows.filter((window) => isUsedUp(window, at.now) && binds(window, at.model));
}

/**
 * When a session that stopped at `stoppedAt` may go on: the latest reset among
 * the used-up windows that bind it. Undefined when none is used up, or when any
 * of them carries no usable time.
 */
export function limitResetAt(
  limits: HarnessLimits,
  at: { now: number; stoppedAt: number; model?: string },
): number | undefined {
  return latestReset(exhaustedWindows(limits, at), { now: at.now, after: at.stoppedAt });
}

/**
 * When a whole harness may be used again: the reset of its used-up windows that
 * bind every model. A window scoped to one model never limits the harness —
 * another model still runs. Undefined when nothing binding is used up, or when
 * any of it carries no usable time.
 */
export function harnessLimitedUntil(limits: HarnessLimits, now: number): number | undefined {
  if (!limits.available) return undefined;
  const used = limits.windows.filter(
    (window) => window.model === undefined && isUsedUp(window, now),
  );
  return latestReset(used, { now, after: now });
}
