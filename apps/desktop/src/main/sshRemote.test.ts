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
  it('resolves each remote once for the run', () => {
    const resolve = vi.fn((remote: string) => remote.replace('@personal:', '@github.com:'));
    const resolveRemote = memoizeRemoteResolver(resolve);
    for (let i = 0; i < 3; i++) {
      expect(resolveRemote('git@personal:sprocket/catalog-portal.git')).toBe(
        'git@github.com:sprocket/catalog-portal.git',
      );
    }
    expect(resolveRemote('git@personal:sprocket/billing.git')).toBe(
      'git@github.com:sprocket/billing.git',
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls.map(([remote]) => remote)).toEqual([
      'git@personal:sprocket/catalog-portal.git',
      'git@personal:sprocket/billing.git',
    ]);
  });
});
