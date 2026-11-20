import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTLE_MS, TurnSettle, type SettledStatus } from './turnSettle';

let finished: Array<[string, SettledStatus]>;

beforeEach(() => {
  vi.useFakeTimers();
  finished = [];
});
afterEach(() => vi.useRealTimers());

const make = () => new TurnSettle((key, status) => finished.push([key, status]));

describe('TurnSettle', () => {
  it('ignores a ready seen before any work: that is the state the prompt found', () => {
    const settle = make();
    settle.observe('a', 'ready');
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(finished).toEqual([]);
  });

  it('reports a finish only after the session has stayed ready for SETTLE_MS', () => {
    const settle = make();
    settle.observe('a', 'working');
    settle.observe('a', 'ready');
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(finished).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(finished).toEqual([['a', 'ready']]);
  });

  it('cancels the pending finish when the session goes back to work', () => {
    const settle = make();
    settle.observe('a', 'working');
    settle.observe('a', 'ready');
    vi.advanceTimersByTime(SETTLE_MS - 1);
    settle.observe('a', 'working');
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(finished).toEqual([]);
  });

  it('settles an exit immediately, even before any work', () => {
    const settle = make();
    settle.observe('a', 'exited');
    expect(finished).toEqual([['a', 'exited']]);
  });

  it('settles needs-attention without having seen work', () => {
    const settle = make();
    settle.observe('a', 'needs-attention');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(finished).toEqual([['a', 'needs-attention']]);
  });

  it('stops a watch that is dropped', () => {
    const settle = make();
    settle.observe('a', 'working');
    settle.observe('a', 'ready');
    settle.unwatch('a');
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(finished).toEqual([]);
  });

  it('watches every key it sees and reports each finished turn', () => {
    const settle = make();
    settle.observe('a', 'ready'); // initial state, not a finish
    vi.advanceTimersByTime(SETTLE_MS);
    expect(finished).toEqual([]);

    for (let turn = 0; turn < 2; turn++) {
      settle.observe('a', 'working');
      settle.observe('a', 'ready');
      vi.advanceTimersByTime(SETTLE_MS);
    }
    expect(finished).toEqual([
      ['a', 'ready'],
      ['a', 'ready'],
    ]);
  });

  it('needs fresh work after a report before the next ready counts', () => {
    const settle = make();
    settle.observe('a', 'working');
    settle.observe('a', 'ready');
    vi.advanceTimersByTime(SETTLE_MS);
    settle.observe('a', 'ready');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(finished).toHaveLength(1);
  });
});
