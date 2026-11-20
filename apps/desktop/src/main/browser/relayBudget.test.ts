import { describe, expect, it } from 'vitest';
import {
  approximateSize,
  EVENT_BUDGET,
  EventBudget,
  TOO_MANY_BYTES_MESSAGE,
  TOO_MANY_EVENTS_MESSAGE,
} from './relayBudget';

const MB = 1024 * 1024;

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('approximateSize', () => {
  it('counts the characters of every string, and a little for every other value', () => {
    expect(approximateSize('abcd', Number.POSITIVE_INFINITY)).toBe(4);
    const small = approximateSize({ a: 1, b: [true, null] }, Number.POSITIVE_INFINITY);
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(100);
    expect(
      approximateSize({ entry: { text: 'x'.repeat(5 * MB) } }, Number.POSITIVE_INFINITY),
    ).toBeGreaterThanOrEqual(5 * MB);
  });

  it('stops counting once it reaches the cap', () => {
    const many = { args: Array.from({ length: 10 }, () => 'x'.repeat(MB)) };
    expect(approximateSize(many, 2 * MB)).toBe(2 * MB);
  });

  it('stops at the cap on a value with too many parts to walk', () => {
    const wide = Array.from({ length: 200_000 }, () => 0);
    expect(approximateSize(wide, 10 * MB)).toBe(10 * MB);
  });
});

describe('EventBudget', () => {
  it('lets a page that stays within the steady rate send for ever', () => {
    const time = clock();
    const budget = new EventBudget(time.now);
    for (let second = 0; second < 60; second++) {
      for (let i = 0; i < EVENT_BUDGET.perSecond / 2; i++) {
        expect(budget.spend({ method: 'Network.dataReceived' })).toBeNull();
      }
      time.advance(1_000);
    }
  });

  it('lets a burst through, as a page’s first load and Chromium’s replay are', () => {
    const budget = new EventBudget(clock().now);
    for (let i = 0; i < EVENT_BUDGET.burst; i++) expect(budget.spend({})).toBeNull();
  });

  it('runs out for a page that keeps sending more than the steady rate', () => {
    const time = clock();
    const budget = new EventBudget(time.now);
    let refusal: string | null = null;
    for (let tick = 0; tick < 1_000 && !refusal; tick++) {
      for (let i = 0; i < EVENT_BUDGET.perSecond / 5; i++) refusal ??= budget.spend({});
      time.advance(100);
    }
    expect(refusal).toBe(TOO_MANY_EVENTS_MESSAGE);
  });

  it('runs out for a page that sends more data than it may, in however few events', () => {
    const budget = new EventBudget(clock().now);
    const huge = { args: [{ type: 'string', value: 'x'.repeat(30 * MB) }] };
    expect(budget.spend(huge)).toBeNull();
    expect(budget.spend(huge)).toBeNull();
    expect(budget.spend(huge)).toBe(TOO_MANY_BYTES_MESSAGE);
  });

  it('fills back while the page is quiet', () => {
    const time = clock();
    const budget = new EventBudget(time.now);
    for (let i = 0; i < EVENT_BUDGET.burst; i++) budget.spend({});
    time.advance(10_000);
    for (let i = 0; i < EVENT_BUDGET.burst; i++) expect(budget.spend({})).toBeNull();
  });

  it('never fills past its burst, however long the page was quiet', () => {
    const time = clock();
    const budget = new EventBudget(time.now);
    time.advance(3_600_000);
    let refusal: string | null = null;
    for (let i = 0; i <= EVENT_BUDGET.burst && !refusal; i++) refusal = budget.spend({});
    expect(refusal).toBe(TOO_MANY_EVENTS_MESSAGE);
  });

  it('takes a clock that goes backwards as no time passed', () => {
    const time = clock();
    const budget = new EventBudget(time.now);
    for (let i = 0; i < EVENT_BUDGET.burst; i++) budget.spend({});
    time.advance(-60_000);
    expect(budget.spend({})).toBe(TOO_MANY_EVENTS_MESSAGE);
  });
});
