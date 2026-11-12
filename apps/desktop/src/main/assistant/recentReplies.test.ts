import { describe, expect, it, vi } from 'vitest';
import type { Harness } from '../../shared/harness';
import { makeSession } from '../conductor/ConductorTools.test';
import type { HarnessDriver } from '../drivers';
import { recentRepliesFor } from './recentReplies';

const session = makeSession({ id: 'w-1', harnessId: 'work', claudeSessionId: '00000000-0000-4000-8000-0000000000aa' });

function harness(overrides: Partial<Harness> = {}): Harness {
  return {
    id: 'work',
    driverId: 'claude',
    name: 'Work',
    accentColor: 'blue',
    enabled: true,
    archived: false,
    isBuiltIn: false,
    configDir: '/profiles/work',
    extraArgs: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('recentRepliesFor', () => {
  it('is null when the harness’s driver cannot read transcripts at all', async () => {
    const driverFor = vi.fn(() => ({}) as HarnessDriver);
    expect(await recentRepliesFor(harness({ driverId: 'codex' }), session, 3, driverFor)).toBeNull();
    expect(driverFor).toHaveBeenCalledWith('codex');
  });

  it('is null for a real driver without transcripts', async () => {
    expect(await recentRepliesFor(harness({ driverId: 'codex' }), session, 3)).toBeNull();
  });

  it('is empty, not null, when a readable harness has no transcript yet', async () => {
    // A session before its first turn: its harness can be read, there is just nothing to read.
    const getRecentReplies = vi.fn(async () => null);
    expect(await recentRepliesFor(harness(), session, 3, () => ({ getRecentReplies }) as unknown as HarnessDriver)).toEqual([]);
  });

  it('reads the session’s own conversation where its harness keeps it', async () => {
    const getRecentReplies = vi.fn(async () => ['Two issues found.']);
    const driverFor = vi.fn(() => ({ getRecentReplies }) as unknown as HarnessDriver);
    expect(await recentRepliesFor(harness(), session, 2, driverFor)).toEqual(['Two issues found.']);
    expect(driverFor).toHaveBeenCalledWith('claude');
    expect(getRecentReplies).toHaveBeenCalledWith(
      expect.objectContaining({ configDir: '/profiles/work' }),
      '00000000-0000-4000-8000-0000000000aa',
      2
    );
  });
});
