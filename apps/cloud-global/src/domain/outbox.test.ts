import { describe, expect, it } from 'vitest';
import { FIRST_RETRY_MS, LONGEST_RETRY_MS, retryDelayMs } from './outbox.js';

describe('retryDelayMs', () => {
  it('waits a second after the first failure, and twice as long after each one more', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(retryDelayMs(1)).toBe(FIRST_RETRY_MS);
  });

  it('never waits longer than five minutes, however many deliveries failed', () => {
    expect(retryDelayMs(9)).toBe(256_000);
    expect(retryDelayMs(10)).toBe(LONGEST_RETRY_MS);
    expect(retryDelayMs(1_000)).toBe(LONGEST_RETRY_MS);
    expect(LONGEST_RETRY_MS).toBe(300_000);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses %s failures, which no retry follows', (failures) => {
    expect(() => retryDelayMs(failures)).toThrow();
  });
});
