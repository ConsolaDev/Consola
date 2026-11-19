import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armAt, MAX_ARM_MS } from './wakeTimer';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('armAt', () => {
  it('does not fire a 30-day wait at once, and fires at its time', () => {
    const fire = vi.fn();
    armAt(30 * DAY, fire);
    vi.advanceTimersByTime(1);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30 * DAY - 2);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('hops at most a day and asks the clock again', () => {
    const fire = vi.fn();
    armAt(3 * DAY, fire);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(MAX_ARM_MS);
    expect(fire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('fires on a recheck after the clock jumped, as after sleep', () => {
    const fire = vi.fn();
    const timer = armAt(2 * DAY, fire);
    vi.setSystemTime(3 * DAY);
    timer.recheck();
    vi.advanceTimersByTime(0);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('fires a time already past on the next tick, never synchronously', () => {
    const fire = vi.fn();
    armAt(-5, fire);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('never fires once cancelled', () => {
    const fire = vi.fn();
    armAt(10, fire).cancel();
    vi.advanceTimersByTime(100);
    expect(fire).not.toHaveBeenCalled();
  });
});
