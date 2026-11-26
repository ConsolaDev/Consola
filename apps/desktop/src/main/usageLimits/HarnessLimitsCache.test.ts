import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessLimits } from '../../shared/usageLimits';
import type { HarnessConfig, HarnessDriver } from '../drivers';
import { HarnessLimitsCache } from './HarnessLimitsCache';

const limits = (usedPercent: number): HarnessLimits => ({
  available: true,
  checkedAt: 0,
  windows: [{ id: 'w', kind: 'session', usedPercent }],
});

function driverAnswering(read: () => Promise<HarnessLimits>) {
  return { id: 'claude', usageLimits: { read: vi.fn(read) } } as unknown as HarnessDriver & {
    usageLimits: { read: ReturnType<typeof vi.fn> };
  };
}

const config = (configDir?: string): HarnessConfig => ({ extraArgs: [], configDir });

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('HarnessLimitsCache', () => {
  it('coalesces asks in flight, and keys by what the harness launches as', async () => {
    const driver = driverAnswering(async () => limits(10));
    const cache = new HarnessLimitsCache();
    await Promise.all([cache.ask(driver, config('/a')), cache.ask(driver, config('/a'))]);
    expect(driver.usageLimits.read).toHaveBeenCalledTimes(1);
    await cache.ask(driver, config('/b'));
    expect(driver.usageLimits.read).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good answer when an ask fails, and remembers no failure', async () => {
    let fail = false;
    const driver = driverAnswering(async () => {
      if (fail) throw new Error('down');
      return limits(30);
    });
    const cache = new HarnessLimitsCache();
    await cache.ask(driver, config());
    fail = true;
    expect(await cache.ask(driver, config())).toBeUndefined();
    expect(cache.last(driver, config())?.limits).toEqual(limits(30));
  });

  it('remembers a login with no plan limits as an answer', async () => {
    const driver = driverAnswering(async () => ({ available: false }));
    const cache = new HarnessLimitsCache();
    await cache.ask(driver, config());
    expect(cache.last(driver, config())?.limits).toEqual({ available: false });
  });

  it('gives a fresh enough answer without asking, and waits at most so long for a new one', async () => {
    vi.useFakeTimers();
    let now = 0;
    const driver = driverAnswering(() => new Promise(() => {}));
    const cache = new HarnessLimitsCache(() => now);
    const pending = cache.fresh(driver, config(), { maxAgeMs: 60_000, waitMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBeUndefined();
    vi.useRealTimers();

    const quick = driverAnswering(async () => limits(5));
    const fresh = new HarnessLimitsCache(() => now);
    await fresh.ask(quick, config());
    now = 30_000;
    await fresh.fresh(quick, config(), { maxAgeMs: 60_000, waitMs: 3000 });
    expect(quick.usageLimits.read).toHaveBeenCalledTimes(1);
  });
});
