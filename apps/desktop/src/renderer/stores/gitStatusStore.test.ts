import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitStatusResult } from '../types/electron';

vi.mock('../services/gitBridge', () => ({
  gitBridge: { getStatus: vi.fn() },
}));

import { gitBridge } from '../services/gitBridge';
import { statsFor, uncommittedFor, useGitStatusStore } from './gitStatusStore';

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

  it('Uncommitted: a row with no value while git reads this checkout for the first time', async () => {
    getStatus.mockResolvedValueOnce(statusOf(12));
    await useGitStatusStore.getState().refresh('/a');

    // A switch to /b: its read is under way and git has not answered for it,
    // so the row stays, with no value, and the rows below it stay put.
    const answerB = heldStatus();
    const moving = useGitStatusStore.getState().refresh('/b');
    expect(uncommittedFor(useGitStatusStore.getState(), '/b')).toBe('reading');

    answerB(statusOf(1));
    await moving;
    expect(uncommittedFor(useGitStatusStore.getState(), '/b')).toEqual(statusOf(1).stats);

    // A re-read of /b keeps git's last answer, not an empty row.
    const answerAgain = heldStatus();
    const again = useGitStatusStore.getState().refresh('/b');
    expect(uncommittedFor(useGitStatusStore.getState(), '/b')).toEqual(statusOf(1).stats);
    answerAgain(statusOf(0));
    await again;
    // A clean tree is git's answer too: counts of nothing, which read None.
    expect(uncommittedFor(useGitStatusStore.getState(), '/b')).toEqual(statusOf(0).stats);
  });

  it('Uncommitted: no row where git said no repository, or nothing is read', async () => {
    const notARepo: GitStatusResult = {
      files: [],
      stats: { modifiedCount: 0, addedLines: 0, removedLines: 0 },
      isGitRepo: false,
      branch: null,
    };
    // Nothing read, nothing under way: a scope below its repository's top,
    // whose status is never refreshed.
    expect(uncommittedFor(useGitStatusStore.getState(), '/repo/packages/web')).toBeNull();

    getStatus.mockResolvedValueOnce(notARepo);
    await useGitStatusStore.getState().refresh('/repo/packages/web');
    expect(uncommittedFor(useGitStatusStore.getState(), '/repo/packages/web')).toBeNull();

    // The focus re-read of that folder: git already said, so no empty row
    // flashes while it reads again.
    const answer = heldStatus();
    const rereading = useGitStatusStore.getState().refresh('/repo/packages/web');
    expect(useGitStatusStore.getState().isLoading).toBe(true);
    expect(uncommittedFor(useGitStatusStore.getState(), '/repo/packages/web')).toBeNull();
    answer(notARepo);
    await rereading;
    expect(uncommittedFor(useGitStatusStore.getState(), '/repo/packages/web')).toBeNull();
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
