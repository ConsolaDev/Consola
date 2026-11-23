import { describe, expect, it, vi } from 'vitest';
import type { HarnessProbeResult } from '../../shared/types';
import { HarnessVersions } from './harnessVersions';

const AVAILABLE = (version?: string): HarnessProbeResult => ({
  available: true,
  resolvedBinary: '/bin/claude',
  ...(version ? { version } : {}),
});

describe('HarnessVersions (plan Call 13)', () => {
  it('asks once per launch description, and the same answer to every caller', async () => {
    const probe = vi.fn(async () => AVAILABLE('2.1.330'));
    const versions = new HarnessVersions(probe);
    const fields = { driverId: 'claude' as const, configDirOverride: '/h/.claude-work' };
    const [a, b] = await Promise.all([versions.get(fields), versions.get(fields)]);
    expect([a, b, await versions.get({ ...fields, extraArgs: ['--verbose'] })]).toEqual([
      '2.1.330',
      '2.1.330',
      '2.1.330',
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(versions.peek(fields)).toBe('2.1.330');
  });

  it('an edited harness (another profile or binary) asks again', async () => {
    const probe = vi.fn(async () => AVAILABLE('2.1.330'));
    const versions = new HarnessVersions(probe);
    await versions.get({ configDirOverride: '/h/.claude-work' });
    await versions.get({ configDirOverride: '/h/.claude-other' });
    await versions.get({ configDirOverride: '/h/.claude-other', binaryOverride: '/opt/claude' });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('a failing probe, or one with no version, gives unknown and is asked again next time', async () => {
    const probe = vi
      .fn<() => Promise<HarnessProbeResult>>()
      .mockRejectedValueOnce(new Error('spawn ENOENT'))
      .mockResolvedValueOnce({ available: false, resolvedBinary: 'claude', error: 'Not found' })
      .mockResolvedValueOnce(AVAILABLE())
      .mockResolvedValueOnce(AVAILABLE('2.1.331'));
    const versions = new HarnessVersions(probe);
    expect(await versions.get({})).toBe('unknown');
    expect(await versions.get({})).toBe('unknown');
    expect(await versions.get({})).toBe('unknown');
    expect(versions.peek({})).toBeUndefined();
    expect(await versions.get({})).toBe('2.1.331');
    expect(probe).toHaveBeenCalledTimes(4);
  });
});
