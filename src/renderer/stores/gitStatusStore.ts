import { create } from 'zustand';
import { useEffect, useRef, useCallback } from 'react';
import { GitFileStatus } from '../types/electron';

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
  // Whether currently fetching status
  isLoading: boolean;
  // Whether the root is a git repository
  isGitRepo: boolean;
  // Current root path being tracked
  rootPath: string | null;
  // Current branch name
  branch: string | null;
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
  isLoading: false,
  isGitRepo: false,
  rootPath: null,
  branch: null,

  refresh: async (rootPath: string) => {
    set({ isLoading: true, rootPath });

    try {
      const result = await window.gitAPI.getStatus(rootPath);

      const fileStatuses = new Map<string, GitFileStatus>();
      for (const file of result.files) {
        fileStatuses.set(file.path, file.status);
      }

      set({
        fileStatuses,
        stats: result.stats,
        isGitRepo: result.isGitRepo,
        branch: result.branch,
        isLoading: false,
      });
    } catch (error) {
      console.error('Failed to fetch git status:', error);
      set({
        fileStatuses: new Map(),
        stats: { modifiedCount: 0, addedLines: 0, removedLines: 0 },
        isGitRepo: false,
        branch: null,
        isLoading: false,
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
      isLoading: false,
      isGitRepo: false,
      rootPath: null,
      branch: null,
    });
  },
}));

/**
 * Hook to enable auto-refresh of git status on window focus.
 * Should be used in a component near the root of the app.
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
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, [handleFocus]);
}
