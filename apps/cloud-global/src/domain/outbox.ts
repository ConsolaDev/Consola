/** How long the outbox waits after a message's first failed delivery before it tries again. */
export const FIRST_RETRY_MS = 1000;

/** The longest the outbox ever waits between two deliveries of one message. */
export const LONGEST_RETRY_MS = 5 * 60_000;

/**
 * How long the outbox waits before it delivers a message again, once `failures` deliveries of it
 * have failed: `FIRST_RETRY_MS` after the first, twice as long after each one more, and never
 * longer than `LONGEST_RETRY_MS`. A message is never given up on, so the wait stops growing
 * rather than the retries stopping.
 */
export function retryDelayMs(failures: number): number {
  if (!Number.isInteger(failures) || failures < 1) {
    throw new Error('A retry follows at least one failed delivery.');
  }
  // 2 ** 30 seconds is far past the cap, and keeps the power from overflowing.
  return Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(failures - 1, 30));
}
