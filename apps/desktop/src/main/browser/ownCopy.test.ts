import { describe, expect, it } from 'vitest';
import { cutCopy, ownCopy } from './ownCopy';
import { MB, retainedBy } from './retainedHeap.test-helpers';

describe('ownCopy', () => {
  it('gives the same text, every code unit as it was', () => {
    const text = 'aé中😀 lone \ud800 end';
    expect(ownCopy(text)).toBe(text);
    expect(ownCopy('')).toBe('');
  });
});

describe('cutCopy', () => {
  it('keeps the first characters asked for, or the whole of a shorter text', () => {
    expect(cutCopy('abcdef', 3)).toBe('abc');
    expect(cutCopy('abc', 10)).toBe('abc');
    expect(cutCopy('abc', 0)).toBe('');
  });

  it('never splits a character made of two code units', () => {
    expect(cutCopy('ab😀cd', 3)).toBe('ab');
    expect(cutCopy('ab😀cd', 4)).toBe('ab😀');
  });

  it('keeps only its own copy, never the whole string it was cut from', () => {
    // The control: a plain slice keeps every source alive.
    expect(retainedBy((text) => text.slice(0, 2_000))).toBeGreaterThan(80 * MB);
    expect(retainedBy((text) => cutCopy(text, 2_000))).toBeLessThan(10 * MB);
  });
});
