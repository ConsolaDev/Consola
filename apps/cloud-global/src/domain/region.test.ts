import { REGIONS } from '@consola/cloud-contract';
import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_REGION, isRegion, REGIONS as DOMAIN_REGIONS } from './region.js';

describe('regions', () => {
  it("are the contract's", () => {
    expect(DOMAIN_REGIONS).toBe(REGIONS);
  });

  it('the deployment organisation is in eu, a listed region', () => {
    expect(DEPLOYMENT_REGION).toBe('eu');
    expect(isRegion(DEPLOYMENT_REGION)).toBe(true);
  });
});
