import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isPageVisible, onPageVisibilityChange } from '../services/pageVisibility';

/**
 * Reads something now and again as long as the page shows it: `tick` reads once and answers how
 * long to wait before the next read, or null to wait for nothing but the page coming back into
 * view. One read at a time; the next waits for the last to answer. A hidden tab reads nothing,
 * and reads at once when it shows again.
 *
 * A new `key` (the list's filters, the run shown) starts again with a read at once, and so does
 * the returned `readNow` (Try again). A read that was under way then is not shown: `tick` gets
 * `current`, which is false for it from then on.
 */
export function usePoll(
  key: string,
  tick: (current: () => boolean) => Promise<number | null>,
): () => void {
  const latestTick = useRef(tick);
  useLayoutEffect(() => {
    latestTick.current = tick;
  });
  const [round, setRound] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` and `round` are what start it again; the tick is read through its ref.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let again = false;
    const current = () => live;

    const read = async () => {
      clearTimeout(timer);
      timer = undefined;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      let delay: number | null;
      try {
        delay = await latestTick.current(current);
      } catch {
        delay = null;
      }
      reading = false;
      if (!live) return;
      if (again) {
        again = false;
        void read();
        return;
      }
      if (delay !== null && isPageVisible()) timer = setTimeout(() => void read(), delay);
    };

    void read();
    const stop = onPageVisibilityChange((visible) => {
      if (!live) return;
      if (visible) void read();
      else {
        clearTimeout(timer);
        timer = undefined;
      }
    });
    return () => {
      live = false;
      clearTimeout(timer);
      stop();
    };
  }, [key, round]);

  return useCallback(() => setRound((n) => n + 1), []);
}

/** The time now, ticking every `everyMs`, for words such as "5m ago" that age as they show. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
