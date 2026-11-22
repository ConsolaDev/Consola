import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitStatusResult } from '../types/electron';

vi.mock('../services/gitBridge', () => ({
  gitBridge: { getStatus: vi.fn() },
}));

import { gitBridge } from '../services/gitBridge';
import { statsFor, useGitStatusStore } from './gitStatusStore';

const getStatus = vi.mocked(gitBridge.getStatus);

const statusOf = (modifiedCount: number): GitStatusResult => ({
  files: [],
  stats: { modifiedCount, addedLines: modifiedCount * 10, removedLines: modifiedCount },
  isGitRepo: true,
  branch: 'main',
});

/** Holds main's next answer until the test gives it. */
function heldStatus(): (status: GitStatusResult) => void {
  let answer!: (status: GitStatusResult) => void;
  getStatus.mockReturnValueOnce(
    new Promise<GitStatusResult>((resolve) => {
      answer = resolve;
    }),
  );
  return answer;
}

beforeEach(() => {
  getStatus.mockReset();
  useGitStatusStore.getState().clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gitStatusStore', () => {
  it('never gives one checkout’s counts for another while a refresh moves between them', async () => {
    getStatus.mockResolvedValueOnce(statusOf(12));
    await useGitStatusStore.getState().refresh('/a');
    expect(statsFor(useGitStatusStore.getState(), '/a')).toEqual(statusOf(12).stats);

    const answerB = heldStatus();
    const moving = useGitStatusStore.getState().refresh('/b');
    // The store already tracks /b, but what it holds is still /a's.
    expect(useGitStatusStore.getState().rootPath).toBe('/b');
    expect(statsFor(useGitStatusStore.getState(), '/b')).toBeUndefined();

    answerB(statusOf(1));
    await moving;
    expect(statsFor(useGitStatusStore.getState(), '/b')).toEqual(statusOf(1).stats);
    expect(statsFor(useGitStatusStore.getState(), '/a')).toBeUndefined();
  });

  it('a failed read is no checkout’s counts, and a cleared store holds none', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getStatus.mockResolvedValueOnce(statusOf(3));
    await useGitStatusStore.getState().refresh('/a');

    getStatus.mockRejectedValueOnce(new Error('ipc closed'));
    await useGitStatusStore.getState().refresh('/a');
    expect(statsFor(useGitStatusStore.getState(), '/a')).toBeUndefined();

    getStatus.mockResolvedValueOnce(statusOf(3));
    await useGitStatusStore.getState().refresh('/a');
    useGitStatusStore.getState().clear();
    expect(statsFor(useGitStatusStore.getState(), '/a')).toBeUndefined();
  });

  it('marks when a read of the tracked root lands, and not when a stale one does', async () => {
    const answerA = heldStatus();
    const stale = useGitStatusStore.getState().refresh('/a');
    getStatus.mockResolvedValueOnce(statusOf(1));
    await useGitStatusStore.getState().refresh('/b');
    const landed = useGitStatusStore.getState().refreshedAt;
    expect(landed).toBeGreaterThan(0);

    // /a's answer comes back after the store moved on: it changes nothing.
    answerA(statusOf(12));
    await stale;
    expect(useGitStatusStore.getState().refreshedAt).toBe(landed);
    expect(statsFor(useGitStatusStore.getState(), '/b')).toEqual(statusOf(1).stats);
  });
});
