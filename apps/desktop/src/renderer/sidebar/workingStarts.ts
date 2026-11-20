import type { Entry } from './entry';

/**
 * Whether a row has just started working: it is working in `now` and was not
 * in `before`, the same rows read against the attention main reported one
 * change earlier.
 *
 * A row missing from `before` was not working, so a session that goes
 * straight from nothing to a turn still counts. A row that was already
 * working never does, whatever brought it into view.
 */
export function startedWorking(now: readonly Entry[], before: readonly Entry[]): boolean {
  const was = new Map(before.map((entry) => [entry.key, entry.attention]));
  return now.some((entry) => entry.attention === 'working' && was.get(entry.key) !== 'working');
}
