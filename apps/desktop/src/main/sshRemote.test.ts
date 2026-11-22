import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  let bin: string;
  let runs: string;
  const path0 = process.env.PATH;
  beforeEach(() => {
    bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-ssh-')));
    runs = path.join(bin, 'runs');
    process.env.PATH = `${bin}${path.delimiter}${path0}`;
  });
  afterEach(() => {
    process.env.PATH = path0;
    fs.rmSync(bin, { recursive: true, force: true });
  });
  /** An `ssh` found first on PATH that logs each run's arguments, then runs `body`. */
  const fakeSsh = (body: string) =>
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\necho "$*" >> "${runs}"\n${body}\n`, {
      mode: 0o755,
    });
  /** The arguments of each run of the fake ssh, in order. */
  const sshRuns = () =>
    fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean) : [];
  const NAMES_GITHUB = "printf 'user git\\nhostname github.com\\nport 22\\n'";

  it('never blocks main on an ssh that hangs, and answers once the lookup gives up', async () => {
    // A slow `Match exec` in the person's ssh config, say.
    fakeSsh('exec sleep 30');
    const resolveRemote = memoizeRemoteResolver();
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 50);
    try {
      const asked = Date.now();
      const answer = resolveRemote(REMOTE);
      expect(Date.now() - asked).toBeLessThan(500);
      await expect(answer).resolves.toBe(REMOTE);
      expect(ticks).toBeGreaterThan(5);
    } finally {
      clearInterval(ticker);
    }
  }, 10_000);

  it('runs one ssh -G for finds that ask about one host at once, and keeps the hostname it named', async () => {
    fakeSsh(`sleep 0.3\n${NAMES_GITHUB}`);
    const resolveRemote = memoizeRemoteResolver();
    await expect(
      Promise.all([resolveRemote(REMOTE), resolveRemote('git@personal:sprocket/billing.git')]),
    ).resolves.toEqual([RESOLVED, 'git@github.com:sprocket/billing.git']);
    await expect(resolveRemote(REMOTE)).resolves.toBe(RESOLVED);
    expect(sshRuns()).toEqual(['-G personal']);
  });

  it('asks again on the next find after an ssh -G that failed', async () => {
    // Fails on its first run only.
    fakeSsh(`[ "$(wc -l < "${runs}")" -gt 1 ] || exit 255\n${NAMES_GITHUB}`);
    const resolveRemote = memoizeRemoteResolver();
    await expect(resolveRemote(REMOTE)).resolves.toBe(REMOTE);
    await expect(resolveRemote(REMOTE)).resolves.toBe(RESOLVED);
    await expect(resolveRemote(REMOTE)).resolves.toBe(RESOLVED);
    expect(sshRuns()).toEqual(['-G personal', '-G personal']);
  });

  it('asks about each host once for the run, whichever remote names it', async () => {
    // An alias resolves to its host; a host that is no alias resolves to itself.
    const resolveHost = vi.fn(async (host: string) => (host === 'personal' ? 'github.com' : host));
    const resolveRemote = memoizeRemoteResolver(resolveHost);
    for (let i = 0; i < 3; i++) await expect(resolveRemote(REMOTE)).resolves.toBe(RESOLVED);
    await expect(resolveRemote(RESOLVED)).resolves.toBe(RESOLVED);
    await expect(resolveRemote(RESOLVED)).resolves.toBe(RESOLVED);
    expect(resolveHost.mock.calls).toEqual([['personal'], ['github.com']]);
  });

  it('never asks about a remote that is not ssh', async () => {
    const resolveHost = vi.fn(async () => 'github.com');
    const resolveRemote = memoizeRemoteResolver(resolveHost);
    const https = 'https://github.com/sprocket/catalog-portal.git';
    await expect(resolveRemote(https)).resolves.toBe(https);
    expect(resolveHost).not.toHaveBeenCalled();
  });
});
