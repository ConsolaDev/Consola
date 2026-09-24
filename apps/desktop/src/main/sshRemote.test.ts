import { describe, expect, it, vi } from 'vitest';
import { resolveSshRemote } from './sshRemote';

describe('resolveSshRemote', () => {
  it.each([
    ['git@github.com-personal:ConsolaDev/Consola.git', 'git@github.com:ConsolaDev/Consola.git'],
    ['ssh://git@personal:2222/ConsolaDev/Consola.git', 'ssh://git@github.com:2222/ConsolaDev/Consola.git'],
    ['personal:ConsolaDev/Consola.git', 'github.com:ConsolaDev/Consola.git'],
  ])('expands the configured host in %s', (remote, expected) => {
    expect(resolveSshRemote(remote, () => 'github.com')).toBe(expected);
  });

  it.each(['https://github.com-personal/ConsolaDev/Consola.git', '/local/repo', 'git@-bad:owner/repo'])('does not resolve %s through SSH', (remote) => {
    const resolve = vi.fn();
    expect(resolveSshRemote(remote, resolve)).toBe(remote);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('preserves the remote when SSH configuration cannot be read', () => {
    const remote = 'git@personal:ConsolaDev/Consola.git';
    expect(resolveSshRemote(remote, () => null)).toBe(remote);
  });
});
