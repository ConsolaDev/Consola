import { create } from 'zustand';
import { useEffect, useRef, useCallback } from 'react';
import type { GitFileStatus } from '../types/electron';
import { gitBridge } from '../services/gitBridge';

interface GitStats {
  modifiedCount: number;
  addedLines: number;
  removedLines: number;
}

interface GitStatusState {
  // Map of relative file path to status
  fileStatuses: Map<string, GitFileStatus>;
  // Aggregated statistics
  stats: GitStats;
  // The checkout `stats` were read from, or null when they are no
  // checkout's (none read yet, or the last read failed). It trails
  // `rootPath` while a refresh moves to another root: read `statsFor`.
  statsRoot: string | null;
  // Whether currently fetching status
  isLoading: boolean;
  // Whether the root is a git repository
  isGitRepo: boolean;
  // Current root path being tracked
  rootPath: string | null;
  // Current branch name
  branch: string | null;
  // When a read of `rootPath` last landed, answered or failed: the moment
  // anything else read from that checkout (its branch's counts) may have
  // moved too. 0 before the first.
  refreshedAt: number;
  // Refresh git status for a path
  refresh: (rootPath: string) => Promise<void>;
  // Get status for a specific file path
  getFileStatus: (filePath: string) => GitFileStatus | null;
  // Clear all status data
  clear: () => void;
}

export const useGitStatusStore = create<GitStatusState>((set, get) => ({
  fileStatuses: new Map(),
  stats: { modifiedCount: 0, addedLines: 0, removedLines: 0 },
  statsRoot: null,
  isLoading: false,
  isGitRepo: false,
  rootPath: null,
  branch: null,
  refreshedAt: 0,

  refresh: async (rootPath: string) => {
    set({ isLoading: true, rootPath });

    try {
      const result = await gitBridge.getStatus(rootPath);
      // The store tracks one checkout. Switching sessions while a read is in
      // flight must not let the old checkout's answer land over the new one.
      if (get().rootPath !== rootPath) return;

      if (!result) {
        throw new Error('Git API not available');
      }

      const fileStatuses = new Map<string, GitFileStatus>();
      for (const file of result.files) {
        fileStatuses.set(file.path, file.status);
      }

      set({
        fileStatuses,
        stats: result.stats,
        statsRoot: rootPath,
        isGitRepo: result.isGitRepo,
        branch: result.branch,
        isLoading: false,
        refreshedAt: Date.now(),
      });
    } catch (error) {
      if (get().rootPath !== rootPath) return;
      console.error('Failed to fetch git status:', error);
      set({
        fileStatuses: new Map(),
        stats: { modifiedCount: 0, addedLines: 0, removedLines: 0 },
        statsRoot: null,
        isGitRepo: false,
        branch: null,
        isLoading: false,
        refreshedAt: Date.now(),
      });
    }
  },

  getFileStatus: (filePath: string) => {
    const { fileStatuses, rootPath } = get();
    if (!rootPath) return null;

    // Convert absolute path to relative path from root
    const relativePath = filePath.startsWith(rootPath)
      ? filePath.slice(rootPath.length + 1) // +1 for the trailing slash
      : filePath;

    return fileStatuses.get(relativePath) ?? null;
  },

  clear: () => {
    set({
      fileStatuses: new Map(),
      stats: { modifiedCount: 0, addedLines: 0, removedLines: 0 },
      statsRoot: null,
      isLoading: false,
      isGitRepo: false,
      rootPath: null,
      branch: null,
      refreshedAt: 0,
    });
  },
}));

/**
 * The uncommitted counts git gave for `dir`, or undefined while the store
 * holds none of its own: before its first read lands, while a refresh moves
 * the store over from another checkout (`rootPath` is already `dir`, but
 * `stats` are still the other's), after a failed read, and for a folder that
 * is no repository's top (main reads status only where `.git` is, so the
 * zeros it answers there count nothing). Git state belongs to the checkout,
 * so it is never another's numbers, and never a `None` git did not say.
 */
export function statsFor(
  state: Pick<GitStatusState, 'stats' | 'statsRoot' | 'isGitRepo'>,
  dir: string,
): GitStats | undefined {
  return state.statsRoot === dir && state.isGitRepo ? state.stats : undefined;
}

/**
 * What the info panel's Uncommitted row draws for `dir`: git's counts for it
 * (`statsFor`); `'reading'`, the row with no value, while a read of `dir` is
 * under way and git has not yet answered for it (a switch from another
 * checkout), so the rows below it do not jump; or null, no row, when no read
 * of `dir` is under way and none has landed, or git said it is no
 * repository's top. A re-read of a folder git already answered for keeps that
 * answer, so a focus re-read never flashes an empty row. Never a `None` git
 * did not say.
 */
export function uncommittedFor(
  state: Pick<GitStatusState, 'stats' | 'statsRoot' | 'isGitRepo' | 'rootPath' | 'isLoading'>,
  dir: string,
): GitStats | 'reading' | null {
  const stats = statsFor(state, dir);
  if (stats) return stats;
  return state.rootPath === dir && state.isLoading && state.statsRoot !== dir ? 'reading' : null;
}

/**
 * Keep git status on `rootPath`: read it whenever the root changes — the
 * header is often the only thing showing it, with no explorer or review panel
 * open to load it — and again when the window regains focus.
 */
export function useGitStatusAutoRefresh(rootPath: string | null) {
  const refresh = useGitStatusStore((state) => state.refresh);
  const isLoading = useGitStatusStore((state) => state.isLoading);
  const lastRefreshTime = useRef<number>(0);

  const handleFocus = useCallback(() => {
    if (!rootPath || isLoading) return;

    // Debounce: only refresh if more than 2 seconds since last refresh
    const now = Date.now();
    if (now - lastRefreshTime.current > 2000) {
      lastRefreshTime.current = now;
      refresh(rootPath);
    }
  }, [rootPath, isLoading, refresh]);

  useEffect(() => {
    if (!rootPath) return;
    lastRefreshTime.current = Date.now();
    void refresh(rootPath);
  }, [rootPath, refresh]);

  useEffect(() => {
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, [handleFocus]);
}
