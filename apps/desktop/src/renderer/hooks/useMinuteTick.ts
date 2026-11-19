import { useEffect, useState } from 'react';

/**
 * One interval for every clock that reads in minutes: snooze countdowns, the
 * menu's wake times, the custom dialog's preview. A copy of `useSecondsTick`'s
 * pattern at a slower beat, so a shelf of countdowns turns over on one frame.
 * Only the display follows it: every wake itself is main's.
 */
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  timer ??= setInterval(() => {
    for (const subscriber of [...subscribers]) subscriber();
  }, 30_000);
  return () => {
    subscribers.delete(notify);
    if (subscribers.size > 0 || timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };
}

/**
 * `Date.now()`, re-read twice a minute while `live` (so a label never lags a
 * minute boundary by more than half a minute). Frozen otherwise.
 */
export function useMinuteTick(live = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    return subscribe(() => setNow(Date.now()));
  }, [live]);
  return now;
}
