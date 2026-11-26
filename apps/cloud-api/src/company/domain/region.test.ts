import { REGIONS } from '../../shared/region.js';
import { describe, expect, it } from 'vitest';
import { isRegion, REGIONS as DOMAIN_REGIONS } from './region.js';

describe('regions', () => {
  it("are the contract's", () => {
    expect(DOMAIN_REGIONS).toBe(REGIONS);
    expect(isRegion('eu')).toBe(true);
    expect(isRegion('ap')).toBe(false);
  });
});
