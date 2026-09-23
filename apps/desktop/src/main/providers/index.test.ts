import { describe, expect, it, vi } from 'vitest';

// composeProviderEnv layers onto the login env; pin it so the assertion is
// about the layering, not about this machine's shell profile.
vi.mock('../LoginEnvironment', () => ({ getLoginEnv: () => ({ PATH: '/usr/bin' }) }));

import type { GitProviderDriver } from './GitProviderDriver';
import { composeProviderEnv, getProviderDriver, layerProviderToken } from './index';

function fakeDriver(overrides: Partial<GitProviderDriver> = {}): GitProviderDriver {
  return {
    id: 'github',
    tokenEnvVar: 'FAKE_TOKEN',
    probe: async () => ({ available: true, accounts: [] }),
    token: async (login) => `tok-${login}`,
    fetchInbox: async () => [],
    checkout: async () => undefined,
    cloneRepo: async () => undefined,
    matchesRemote: () => false,
    workItemUrl: () => '',
    seedHeader: () => '',
    ...overrides,
  };
}

describe('getProviderDriver', () => {
  it('resolves the GitHub driver, the same instance every time', () => {
    const driver = getProviderDriver('github');

    expect(driver.id).toBe('github');
    expect(driver.tokenEnvVar).toBe('GH_TOKEN');
    // A registry, not a factory: one token cache per provider for the app.
    expect(getProviderDriver('github')).toBe(driver);
  });

  it('throws for an id it does not know — callers degrade inside their own paths', () => {
    // Unlike getDriver (harnesses), which falls back so a spawn survives a
    // stale id, a wrong provider must not silently become GitHub: it would
    // fetch and push to the wrong host. Every live caller catches this.
    expect(() => getProviderDriver('gitlab' as never)).toThrow('Unknown git provider "gitlab".');
  });
});

describe('layerProviderToken', () => {
  it("adds the token under the driver's variable, on a copy of the env", () => {
    const base = { PATH: '/usr/bin' };

    const layered = layerProviderToken(base, 'GH_TOKEN', 'gho_x');

    expect(layered).toEqual({ PATH: '/usr/bin', GH_TOKEN: 'gho_x' });
    expect(base).not.toHaveProperty('GH_TOKEN');
  });

  it('returns a token-free copy when there is no token', () => {
    const base = { PATH: '/usr/bin' };

    const layered = layerProviderToken(base, 'GH_TOKEN', null);

    expect(layered).toEqual({ PATH: '/usr/bin' });
    expect(layered).not.toBe(base);
  });

  it('returns a token-free copy when there is no variable to put it in', () => {
    expect(layerProviderToken({ PATH: '/usr/bin' }, null, 'gho_x')).toEqual({ PATH: '/usr/bin' });
  });
});

describe('composeProviderEnv', () => {
  it("layers the account's token onto the login environment under the driver's variable", async () => {
    await expect(composeProviderEnv(fakeDriver(), 'SymJavi')).resolves.toEqual({
      PATH: '/usr/bin',
      FAKE_TOKEN: 'tok-SymJavi',
    });
  });

  it('propagates a token failure so the caller can degrade', async () => {
    const driver = fakeDriver({
      token: async () => {
        throw new Error('no oauth token found');
      },
    });

    await expect(composeProviderEnv(driver, 'nobody')).rejects.toThrow('no oauth token found');
  });
});
