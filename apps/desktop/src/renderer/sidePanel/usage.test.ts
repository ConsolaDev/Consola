import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  rankShortcutKinds,
  recordUse,
  sanitizeUsage,
  USAGE_HALF_LIFE_MS,
  USAGE_MAX_PER_KIND,
  USAGE_WINDOW_MS,
  usageScore,
} from './usage';
import type { UsageLog } from './usage';

const order = ['changes', 'files', 'terminal', 'pull-request'];
const now = Date.UTC(2026, 10, 20);
const daysAgo = (days: number) => now - days * DAY_MS;

describe('rankShortcutKinds', () => {
  it('a new install shows the first three kinds', () => {
    expect(rankShortcutKinds({}, order, now)).toEqual(['changes', 'files', 'terminal']);
  });

  it('a used kind joins, and the set stays in registry order', () => {
    expect(rankShortcutKinds({ 'pull-request': [now] }, order, now)).toEqual([
      'changes',
      'files',
      'pull-request',
    ]);
  });

  it('recent use beats old use', () => {
    const old = daysAgo(25);
    const log: UsageLog = {
      'pull-request': [old, old, old],
      changes: [now],
      files: [now],
      terminal: [now],
    };
    expect(usageScore(log['pull-request'], now)).toBeCloseTo(0.25, 2);
    expect(rankShortcutKinds(log, order, now)).toEqual(['changes', 'files', 'terminal']);
  });

  it('breaks a tie by registry order', () => {
    const log: UsageLog = {
      'pull-request': [now],
      terminal: [now],
      files: [now],
      changes: [now],
    };
    expect(rankShortcutKinds(log, order, now)).toEqual(['changes', 'files', 'terminal']);
  });

  it('ignores kinds the registry does not list, and takes as many slots as asked', () => {
    const log: UsageLog = { browser: [now, now, now], terminal: [now] };
    expect(rankShortcutKinds(log, order, now)).toEqual(['changes', 'files', 'terminal']);
    expect(rankShortcutKinds(log, order, now, 1)).toEqual(['terminal']);
    expect(rankShortcutKinds(log, order, now, 9)).toEqual(order);
  });
});

describe('usageScore', () => {
  it('uses older than the window count for nothing', () => {
    expect(usageScore([now - 31 * DAY_MS], now)).toBe(0);
  });

  it('counts a use today as one, and half as much a week later', () => {
    expect(usageScore([now], now)).toBe(1);
    expect(usageScore([now - USAGE_HALF_LIFE_MS], now)).toBeCloseTo(0.5, 10);
    expect(usageScore([now, now - USAGE_HALF_LIFE_MS], now)).toBeCloseTo(1.5, 10);
    expect(usageScore([], now)).toBe(0);
  });
});

describe('recordUse', () => {
  it('recordUse prunes and caps', () => {
    const log: UsageLog = { changes: [daysAgo(40), daysAgo(31), daysAgo(2)] };
    expect(recordUse(log, 'changes', now)).toEqual({ changes: [daysAgo(2), now] });
    // Recorded before the clock went back: keeping it would break oldest first.
    expect(recordUse({ changes: [now + DAY_MS] }, 'changes', now)).toEqual({ changes: [now] });

    let capped: UsageLog = {};
    for (let i = 0; i < 250; i += 1) capped = recordUse(capped, 'files', now + i);
    expect(capped.files).toHaveLength(USAGE_MAX_PER_KIND);
    expect(capped.files[0]).toBe(now + 50);
    expect(capped.files[capped.files.length - 1]).toBe(now + 249);
  });

  it('leaves its input and the other kinds alone', () => {
    const terminal = [daysAgo(1)];
    const log: UsageLog = { changes: [daysAgo(3)], terminal };
    const next = recordUse(log, 'changes', now);
    expect(log).toEqual({ changes: [daysAgo(3)], terminal: [daysAgo(1)] });
    expect(next.terminal).toBe(terminal);
    expect(recordUse({}, 'files', now)).toEqual({ files: [now] });
  });
});

describe('sanitizeUsage', () => {
  const known = ['changes', 'files', 'terminal'];

  it('answers {} for non-objects', () => {
    for (const raw of [undefined, null, 42, 'x', true, [], [[now]]]) {
      expect(sanitizeUsage(raw, known, now)).toEqual({});
    }
  });

  it('drops unknown kinds, non-numbers, future times and expired times', () => {
    const raw = {
      changes: [now, 'x', null, {}, Number.NaN, Number.POSITIVE_INFINITY, daysAgo(1)],
      files: [now + 1, daysAgo(31), now - USAGE_WINDOW_MS],
      terminal: 'not a list',
      browser: [now],
    };
    expect(sanitizeUsage(raw, known, now)).toEqual({
      changes: [daysAgo(1), now],
      files: [now - USAGE_WINDOW_MS],
    });
  });

  it('keeps the newest uses, oldest first, and no more than the cap', () => {
    const many = Array.from({ length: 250 }, (_, i) => now - i);
    const kept = sanitizeUsage({ changes: many }, known, now).changes;
    expect(kept).toHaveLength(USAGE_MAX_PER_KIND);
    expect(kept[0]).toBe(now - 199);
    expect(kept[kept.length - 1]).toBe(now);
  });

  it('leaves out a kind with nothing left', () => {
    expect(sanitizeUsage({ changes: [daysAgo(45)], files: [] }, known, now)).toEqual({});
  });
});
