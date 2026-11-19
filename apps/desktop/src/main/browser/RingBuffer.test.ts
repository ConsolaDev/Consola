import { describe, expect, it } from 'vitest';
import { RingBuffer } from './RingBuffer';

describe('RingBuffer', () => {
  it('keeps what was pushed, oldest first', () => {
    const ring = new RingBuffer<number>(3);
    ring.push(1);
    ring.push(2);
    expect(ring.size).toBe(2);
    expect(ring.drain()).toEqual({ items: [1, 2], dropped: 0 });
  });

  it('keeps only the newest `capacity` items and counts the ones pushed out', () => {
    const ring = new RingBuffer<number>(3);
    for (let i = 1; i <= 7; i++) ring.push(i);
    expect(ring.size).toBe(3);
    expect(ring.drain()).toEqual({ items: [5, 6, 7], dropped: 4 });
  });

  it('is empty after a drain, with the dropped count starting over', () => {
    const ring = new RingBuffer<string>(2);
    ring.push('a');
    ring.push('b');
    ring.push('c');
    ring.drain();
    expect(ring.size).toBe(0);
    expect(ring.drain()).toEqual({ items: [], dropped: 0 });
    ring.push('d');
    expect(ring.drain()).toEqual({ items: ['d'], dropped: 0 });
  });

  it('never grows past its capacity however much is pushed', () => {
    const ring = new RingBuffer<number>(200);
    for (let i = 0; i < 100_000; i++) ring.push(i);
    expect(ring.size).toBe(200);
    const { items, dropped } = ring.drain();
    expect(items[0]).toBe(99_800);
    expect(items[199]).toBe(99_999);
    expect(dropped).toBe(99_800);
  });

  it('refuses a capacity that could hold nothing', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(-1)).toThrow(RangeError);
    expect(() => new RingBuffer(1.5)).toThrow(RangeError);
  });
});
