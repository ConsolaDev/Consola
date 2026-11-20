import { describe, expect, it } from 'vitest';
import {
  exhaustedWindows,
  harnessLimitedUntil,
  type HarnessLimits,
  limitResetAt,
  type UsageWindow,
} from './usageLimits';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function limits(...windows: UsageWindow[]): HarnessLimits {
  return { available: true, checkedAt: NOW, windows };
}

const session = (usedPercent: number, resetsAt?: number): UsageWindow => ({
  id: 'five_hour',
  kind: 'session',
  usedPercent,
  ...(resetsAt === undefined ? {} : { resetsAt }),
});
const weekly = (usedPercent: number, resetsAt?: number): UsageWindow => ({
  id: 'seven_day',
  kind: 'weekly',
  usedPercent,
  ...(resetsAt === undefined ? {} : { resetsAt }),
});
const opus = (usedPercent: number, resetsAt?: number): UsageWindow => ({
  id: 'seven_day_opus',
  kind: 'weekly',
  usedPercent,
  model: 'Opus',
  ...(resetsAt === undefined ? {} : { resetsAt }),
});

describe('exhaustedWindows', () => {
  it('counts a window as used up at 100% while its reset is still ahead', () => {
    expect(exhaustedWindows(limits(session(100, NOW + HOUR)), { now: NOW })).toHaveLength(1);
    expect(exhaustedWindows(limits(session(112, NOW + HOUR)), { now: NOW })).toHaveLength(1);
  });

  it('does not count one below 100%', () => {
    expect(exhaustedWindows(limits(session(99.9, NOW + HOUR)), { now: NOW })).toEqual([]);
  });

  it('stops counting it once its reset has passed', () => {
    expect(exhaustedWindows(limits(session(100, NOW - 1)), { now: NOW })).toEqual([]);
    expect(exhaustedWindows(limits(session(100, NOW)), { now: NOW })).toEqual([]);
  });

  it('counts a used-up window with no time, since nothing says it has reset', () => {
    expect(exhaustedWindows(limits(session(100)), { now: NOW })).toHaveLength(1);
  });

  it('binds a scoped window only to a session on its model', () => {
    const answer = limits(opus(100, NOW + DAY));
    expect(exhaustedWindows(answer, { now: NOW, model: 'claude-opus-4-1' })).toHaveLength(1);
    expect(exhaustedWindows(answer, { now: NOW, model: 'opus' })).toHaveLength(1);
    expect(exhaustedWindows(answer, { now: NOW, model: 'OPUS[1m]' })).toHaveLength(1);
    expect(exhaustedWindows(answer, { now: NOW, model: 'sonnet' })).toEqual([]);
    // A session with no model runs on the CLI's default, which a scoped window cannot be said to bind.
    expect(exhaustedWindows(answer, { now: NOW })).toEqual([]);
  });

  it('folds punctuation on both sides when matching a model', () => {
    const answer = limits({ ...opus(100, NOW + DAY), model: 'Opus 4.1' });
    expect(exhaustedWindows(answer, { now: NOW, model: 'claude-opus-4-1' })).toHaveLength(1);
    expect(exhaustedWindows(answer, { now: NOW, model: 'claude-opus-4-5' })).toEqual([]);
  });

  it('finds nothing in a harness that keeps no limits', () => {
    expect(exhaustedWindows({ available: false }, { now: NOW })).toEqual([]);
  });
});

describe('limitResetAt', () => {
  const at = { now: NOW, stoppedAt: NOW - 1000 };

  it('is the reset of the one used-up window', () => {
    expect(limitResetAt(limits(session(100, NOW + HOUR), weekly(40, NOW + DAY)), at)).toBe(
      NOW + HOUR,
    );
  });

  it('is the latest reset among the used-up windows, since the session waits for all of them', () => {
    expect(limitResetAt(limits(session(100, NOW + HOUR), weekly(100, NOW + 3 * DAY)), at)).toBe(
      NOW + 3 * DAY,
    );
  });

  it('has no time when nothing is used up', () => {
    expect(limitResetAt(limits(session(80, NOW + HOUR)), at)).toBeUndefined();
    expect(limitResetAt({ available: false }, at)).toBeUndefined();
  });

  it('has no time when any used-up window lacks one, rather than waking early', () => {
    expect(limitResetAt(limits(session(100, NOW + HOUR), weekly(100)), at)).toBeUndefined();
    expect(
      limitResetAt(limits(session(100, NOW + HOUR), weekly(100, Number.NaN)), at),
    ).toBeUndefined();
  });

  it('ignores a used-up window that does not bind the session', () => {
    const answer = limits(session(100, NOW + HOUR), opus(100, NOW + 3 * DAY));
    expect(limitResetAt(answer, { ...at, model: 'sonnet' })).toBe(NOW + HOUR);
    expect(limitResetAt(answer, { ...at, model: 'opus' })).toBe(NOW + 3 * DAY);
  });

  it('discards a time more than 31 days ahead', () => {
    expect(limitResetAt(limits(session(100, NOW + 31 * DAY)), at)).toBe(NOW + 31 * DAY);
    expect(limitResetAt(limits(session(100, NOW + 31 * DAY + 1)), at)).toBeUndefined();
    // Seconds read as milliseconds land in another millennium.
    expect(limitResetAt(limits(session(100, (NOW + HOUR) * 1000)), at)).toBeUndefined();
  });

  it('discards a time not after the stop', () => {
    const stoppedAt = NOW + 2 * HOUR;
    expect(limitResetAt(limits(session(100, NOW + HOUR)), { now: NOW, stoppedAt })).toBeUndefined();
    expect(limitResetAt(limits(session(100, stoppedAt)), { now: NOW, stoppedAt })).toBeUndefined();
  });
});

describe('harnessLimitedUntil', () => {
  it('is the reset of the used-up windows that bind every model', () => {
    expect(harnessLimitedUntil(limits(session(100, NOW + HOUR), weekly(50, NOW + DAY)), NOW)).toBe(
      NOW + HOUR,
    );
    expect(harnessLimitedUntil(limits(session(100, NOW + HOUR), weekly(100, NOW + DAY)), NOW)).toBe(
      NOW + DAY,
    );
  });

  it('ignores scoped windows: another model still runs', () => {
    expect(harnessLimitedUntil(limits(opus(100, NOW + DAY)), NOW)).toBeUndefined();
    expect(
      harnessLimitedUntil(limits(session(100, NOW + HOUR), opus(100, NOW + 3 * DAY)), NOW),
    ).toBe(NOW + HOUR);
  });

  it('has no time when one binding used-up window lacks one, or when nothing is used up', () => {
    expect(harnessLimitedUntil(limits(session(100, NOW + HOUR), weekly(100)), NOW)).toBeUndefined();
    expect(harnessLimitedUntil(limits(session(20, NOW + HOUR)), NOW)).toBeUndefined();
    expect(harnessLimitedUntil({ available: false }, NOW)).toBeUndefined();
  });

  it('discards a time more than 31 days ahead', () => {
    expect(harnessLimitedUntil(limits(weekly(100, NOW + 40 * DAY)), NOW)).toBeUndefined();
  });
});
