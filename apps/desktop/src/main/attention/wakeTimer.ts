/**
 * The longest single wait. Node fires a `setTimeout` longer than 2³¹-1 ms
 * (about 24.8 days) at once, and a sleeping machine stretches a long wait past
 * its time; hopping at most a day and asking the clock again avoids both.
 */
export const MAX_ARM_MS = 24 * 60 * 60 * 1000;

export interface ArmedTimer {
  cancel(): void;
  /** Ask the clock again now: after the machine wakes, the time may already have passed. */
  recheck(): void;
}

/**
 * Call `fire` once, at or soon after `at`. Every timer main keeps for a wall
 * clock time goes through here: a 30-day snooze must not come back at once.
 * A time already past fires on the next tick, never synchronously, so a caller
 * that arms inside its own bookkeeping is not re-entered.
 */
export function armAt(at: number, fire: () => void, now: () => number = Date.now): ArmedTimer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    if (done) return;
    const wait = Math.max(0, at - now());
    timer = setTimeout(
      () => {
        timer = undefined;
        if (done) return;
        if (now() >= at) {
          done = true;
          fire();
        } else schedule();
      },
      Math.min(wait, MAX_ARM_MS),
    );
    // A pending wake must not keep the process alive.
    timer.unref?.();
  };
  schedule();
  return {
    cancel: () => {
      done = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    recheck: schedule,
  };
}
