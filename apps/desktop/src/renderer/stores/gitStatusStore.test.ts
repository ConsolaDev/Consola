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

  it('a folder that is no repository’s top has no counts: git was never asked about its changes', async () => {
    // Main reads status only where `.git` is: a scope below its repository's
    // top answers no repository, with zeros that are no count of anything.
    getStatus.mockResolvedValueOnce({
      files: [],
      stats: { modifiedCount: 0, addedLines: 0, removedLines: 0 },
      isGitRepo: false,
      branch: null,
    });
    await useGitStatusStore.getState().refresh('/repo/packages/web');
    expect(useGitStatusStore.getState().statsRoot).toBe('/repo/packages/web');
    expect(statsFor(useGitStatusStore.getState(), '/repo/packages/web')).toBeUndefined();

    // A folder the store has never read has none either.
    expect(statsFor(useGitStatusStore.getState(), '/repo')).toBeUndefined();

    // A repository whose working tree is clean: zeros git gave, which are counts.
    getStatus.mockResolvedValueOnce(statusOf(0));
    await useGitStatusStore.getState().refresh('/repo');
    expect(statsFor(useGitStatusStore.getState(), '/repo')).toEqual(statusOf(0).stats);
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
