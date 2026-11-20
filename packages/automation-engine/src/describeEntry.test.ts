import { describe, expect, it } from 'vitest';
import { describeEvery } from './describeEntry';

describe('describeEvery', () => {
  it.each([
    [30 * 60_000, { words: '30 minutes', short: '30m' }],
    [60 * 60_000, { words: '1 hour', short: '1h' }],
    [90 * 60_000, { words: '90 minutes', short: '90m' }],
    [120 * 60_000, { words: '2 hours', short: '2h' }],
  ])('%i ms reads as %o', (ms, words) => {
    expect(describeEvery(ms)).toEqual(words);
  });
});
