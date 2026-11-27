import { describe, expect, it } from 'vitest';
import { isRegion, REGIONS } from './region.js';

describe('regions', () => {
  it('are eu and us', () => {
    expect(REGIONS).toEqual(['eu', 'us']);
  });

  it('isRegion accepts only a listed region', () => {
    expect(isRegion('eu')).toBe(true);
    expect(isRegion('us')).toBe(true);
    expect(isRegion('EU')).toBe(false);
    expect(isRegion('ap')).toBe(false);
    expect(isRegion('')).toBe(false);
    expect(isRegion(null)).toBe(false);
  });
});
