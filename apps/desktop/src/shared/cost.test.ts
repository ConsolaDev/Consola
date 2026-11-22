import { describe, expect, it } from 'vitest';
import { formatCostUsd } from './cost';

describe('formatCostUsd', () => {
  it.each<[number, string]>([
    [0, '$0.0000 est.'],
    [0.0412, '$0.0412 est.'],
    [0.5, '$0.5000 est.'],
    [1.5, '$1.50 est.'],
    [12, '$12.00 est.'],
  ])('%s is %s', (usd, expected) => {
    expect(formatCostUsd(usd)).toBe(expected);
  });
});
