import { describe, expect, it, vi } from 'vitest';
import { memoizeRemoteResolver, resolveSshRemote } from './sshRemote';

describe('resolveSshRemote', () => {
  it.each([
    ['git@github.com-personal:ConsolaDev/Consola.git', 'git@github.com:ConsolaDev/Consola.git'],
    [
      'ssh://git@personal:2222/ConsolaDev/Consola.git',
      'ssh://git@github.com:2222/ConsolaDev/Consola.git',
    ],
    ['personal:ConsolaDev/Consola.git', 'github.com:ConsolaDev/Consola.git'],
  ])('expands the configured host in %s', (remote, expected) => {
    expect(resolveSshRemote(remote, () => 'github.com')).toBe(expected);
  });

  it.each([
    'https://github.com-personal/ConsolaDev/Consola.git',
    '/local/repo',
    'git@-bad:owner/repo',
  ])('does not resolve %s through SSH', (remote) => {
    const resolve = vi.fn();
    expect(resolveSshRemote(remote, resolve)).toBe(remote);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('preserves the remote when SSH configuration cannot be read', () => {
    const remote = 'git@personal:ConsolaDev/Consola.git';
    expect(resolveSshRemote(remote, () => null)).toBe(remote);
  });
});

describe('memoizeRemoteResolver', () => {
  const REMOTE = 'git@personal:sprocket/catalog-portal.git';
  const RESOLVED = 'git@github.com:sprocket/catalog-portal.git';

  it('asks about each host once for the run, whichever remote names it', () => {
    // An alias resolves to its host; a host that is no alias resolves to itself.
    const resolveHost = vi.fn((host: string) => (host === 'personal' ? 'github.com' : host));
    const resolveRemote = memoizeRemoteResolver(resolveHost);
    for (let i = 0; i < 3; i++) expect(resolveRemote(REMOTE)).toBe(RESOLVED);
    expect(resolveRemote('git@personal:sprocket/billing.git')).toBe(
      'git@github.com:sprocket/billing.git',
    );
    expect(resolveRemote(RESOLVED)).toBe(RESOLVED);
    expect(resolveRemote(RESOLVED)).toBe(RESOLVED);
    expect(resolveHost.mock.calls).toEqual([['personal'], ['github.com']]);
  });

  it('asks again after a lookup that gave no host, so Retry can recover the alias', () => {
    // ssh -G failed or timed out once, then answered.
    const resolveHost = vi.fn<(host: string) => string | null>(() => 'github.com');
    resolveHost.mockReturnValueOnce(null);
    const resolveRemote = memoizeRemoteResolver(resolveHost);
    expect(resolveRemote(REMOTE)).toBe(REMOTE);
    expect(resolveRemote(REMOTE)).toBe(RESOLVED);
    expect(resolveRemote(REMOTE)).toBe(RESOLVED);
    expect(resolveHost).toHaveBeenCalledTimes(2);
  });

  it('never asks about a remote that is not ssh', () => {
    const resolveHost = vi.fn(() => 'github.com');
    const resolveRemote = memoizeRemoteResolver(resolveHost);
    const https = 'https://github.com/sprocket/catalog-portal.git';
    expect(resolveRemote(https)).toBe(https);
    expect(resolveHost).not.toHaveBeenCalled();
  });
});
