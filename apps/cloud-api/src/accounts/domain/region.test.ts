import { isRegion, REGIONS } from '../../shared/region.js';
import { describe, expect, it } from 'vitest';
import { isRegion as domainIsRegion, REGIONS as DOMAIN_REGIONS } from './region.js';

describe('regions', () => {
  it("are the app's one list", () => {
    expect(DOMAIN_REGIONS).toBe(REGIONS);
    expect(domainIsRegion).toBe(isRegion);
  });
});
