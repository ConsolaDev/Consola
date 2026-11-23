import { describe, expect, it } from 'vitest';
import { repoInOrg } from './repoInOrg';

describe('repoInOrg', () => {
  it('takes any repository when the workspace names no organization', () => {
    expect(repoInOrg('sprocket/catalog-portal', undefined)).toBe(true);
    expect(repoInOrg('elsewhere/catalog-portal', '')).toBe(true);
  });

  it('takes a repository the organization owns, whatever the casing of either', () => {
    expect(repoInOrg('sprocket/catalog-portal', 'sprocket')).toBe(true);
    expect(repoInOrg('Sprocket/catalog-portal', 'sprocket')).toBe(true);
    expect(repoInOrg('sprocket/catalog-portal', 'SPROCKET')).toBe(true);
  });

  it('refuses a repository another owner holds, even one named like the organization', () => {
    expect(repoInOrg('elsewhere/catalog-portal', 'sprocket')).toBe(false);
    expect(repoInOrg('sprocket-labs/catalog-portal', 'sprocket')).toBe(false);
    expect(repoInOrg('elsewhere/sprocket', 'sprocket')).toBe(false);
  });
});
