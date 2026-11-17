import { useEffect, useState } from 'react';

/**
 * One interval for the whole app, shared by every live counter.
 *
 * A per-row timer would be one `setInterval` per working session, each waking
 * React on its own phase — the list would re-render in a ragged stutter
 * instead of as one list. Subscribers share a single tick, so every counter
 * on screen moves on the same frame, and the interval only exists while
 * something is counting.
 */
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  timer ??= setInterval(() => {
    for (const subscriber of [...subscribers]) subscriber();
  }, 1000);
  return () => {
    subscribers.delete(notify);
    if (subscribers.size > 0 || timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };
}

/**
 * `Date.now()`, re-read every second while `live`. Returns a frozen moment
 * otherwise, so a row that is not counting never re-renders for the clock.
 */
export function useSecondsTick(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    // The moment a counter starts is its own: waiting a second for the first
    // tick would show a stale number from whenever the row last rendered.
    setNow(Date.now());
    return subscribe(() => setNow(Date.now()));
  }, [live]);
  return now;
}
