/**
 * How often the person opens each kind of tab, and which kinds the session
 * header offers as shortcuts because of it. A use counts for less as it ages,
 * half as much every `USAGE_HALF_LIFE_MS`, and for nothing once it is older
 * than `USAGE_WINDOW_MS`, so what the person opens now outweighs what they
 * used to.
 *
 * The header's set is worked out once, when the app starts, and listed in
 * registry order rather than by score. Only which kinds are shown changes from
 * one launch to the next, never their order, and nothing moves under the
 * pointer while the app runs.
 *
 * Kind ids are plain strings here, so this module knows nothing of the
 * registry. Every function is pure.
 */

export type UsageLog = Record<string, number[]>; // kind id -> epoch ms of each counted use, oldest first

export const DAY_MS = 86_400_000;
export const USAGE_WINDOW_MS = 30 * DAY_MS;
export const USAGE_HALF_LIFE_MS = 7 * DAY_MS;
/** Bounds what storage holds for a kind opened many times a day. */
export const USAGE_MAX_PER_KIND = 200;
export const SHORTCUT_SLOTS = 3;

/**
 * Appends a use of `kind` at `now`, then keeps that kind's uses that still
 * count, at most `USAGE_MAX_PER_KIND` of them. A use later than `now` was
 * recorded before the clock went back: dropping it keeps the list oldest first.
 */
export function recordUse(log: UsageLog, kind: string, now: number): UsageLog {
  const kept = (log[kind] ?? []).filter((time) => counts(time, now));
  kept.push(now);
  return { ...log, [kind]: kept.slice(-USAGE_MAX_PER_KIND) };
}

/** Each use inside the window adds `0.5^(age / half-life)`: one today, half a week ago. */
export function usageScore(times: readonly number[], now: number): number {
  let score = 0;
  for (const time of times) {
    if (counts(time, now)) score += 0.5 ** ((now - time) / USAGE_HALF_LIFE_MS);
  }
  return score;
}

/**
 * The `slots` kinds of `registryOrder` with the highest scores, a tie going to
 * the kind listed first, returned in registry order. Kinds in the log that the
 * registry does not list are not candidates.
 */
export function rankShortcutKinds<K extends string>(
  log: UsageLog,
  registryOrder: readonly K[],
  now: number,
  slots: number = SHORTCUT_SLOTS,
): K[] {
  const scores = registryOrder.map((kind) => usageScore(log[kind] ?? [], now));
  const chosen = new Set(
    registryOrder
      .map((_, index) => index)
      .sort((a, b) => scores[b] - scores[a] || a - b)
      .slice(0, slots),
  );
  return registryOrder.filter((_, index) => chosen.has(index));
}

/**
 * Turns whatever storage holds into a log the functions above can act on. A
 * profile can come from another build or be junk, so a kind this build does
 * not know, a time that is not a number, one after `now` and one that no
 * longer counts are all dropped, and a kind left with no uses is left out.
 */
export function sanitizeUsage(raw: unknown, known: readonly string[], now: number): UsageLog {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const kinds = new Set(known);
  const log: UsageLog = {};
  for (const [kind, times] of Object.entries(raw)) {
    if (!kinds.has(kind) || !Array.isArray(times)) continue;
    const kept = times
      .filter((time): time is number => typeof time === 'number' && counts(time, now))
      .sort((a, b) => a - b)
      .slice(-USAGE_MAX_PER_KIND);
    if (kept.length > 0) log[kind] = kept;
  }
  return log;
}

/** NaN and the infinities never count: each fails one comparison or the other. */
function counts(time: number, now: number): boolean {
  return time <= now && now - time <= USAGE_WINDOW_MS;
}
