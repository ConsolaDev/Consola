import { isRegion, REGIONS } from '@consola/cloud-contract';
import { describe, expect, it } from 'vitest';
import { isRegion as domainIsRegion, REGIONS as DOMAIN_REGIONS } from './region.js';

describe('regions', () => {
  it("are the contract's", () => {
    expect(DOMAIN_REGIONS).toBe(REGIONS);
    expect(domainIsRegion).toBe(isRegion);
  });
});
