import { describe, expect, it } from 'vitest';
import { elapsedLabel } from './elapsedLabel';

const NOW = 1_700_000_000_000;
const ago = (ms: number) => elapsedLabel(NOW - ms, NOW);

describe('elapsedLabel', () => {
  it('counts the first minute in seconds, from zero', () => {
    expect(ago(0)).toBe('0s');
    expect(ago(900)).toBe('0s');
    expect(ago(12_000)).toBe('12s');
    expect(ago(59_999)).toBe('59s');
  });

  it('steps up a unit only once the unit is whole', () => {
    expect(ago(60_000)).toBe('1m');
    expect(ago(59 * 60_000 + 59_000)).toBe('59m');
    expect(ago(60 * 60_000)).toBe('1h');
    expect(ago(23.5 * 3_600_000)).toBe('23h');
    expect(ago(24 * 3_600_000)).toBe('1d');
  });

  it('never runs backwards when a clock or a late edge puts the start ahead', () => {
    expect(elapsedLabel(NOW + 5_000, NOW)).toBe('0s');
  });
});
