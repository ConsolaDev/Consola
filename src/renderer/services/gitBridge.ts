import type { GitStatusResult, GitDiffResult } from '../types/electron';

/**
 * Git Bridge - Isolates all window.gitAPI access to this single file.
 *
 * Why: Electron's contextBridge can only expose APIs on the window object.
 * This bridge wraps that access so the rest of the app doesn't touch window directly.
 */

function getAPI() {
  if (typeof window !== 'undefined' && window.gitAPI) {
    return window.gitAPI;
  }
  return null;
}

export const gitBridge = {
  /** Check if the git API is available */
  isAvailable: (): boolean => {
    return getAPI() !== null;
  },

  /** Get git status for a directory */
  getStatus: async (rootPath: string): Promise<GitStatusResult | null> => {
    const api = getAPI();
    if (!api) {
      return null;
    }
    return api.getStatus(rootPath);
  },

  /** Get diff for a specific file */
  getDiff: async (rootPath: string, filePath: string, staged: boolean): Promise<GitDiffResult | null> => {
    const api = getAPI();
    if (!api) {
      return null;
    }
    return api.getDiff(rootPath, filePath, staged);
  },

  /** Stage a file (git add) */
  stageFile: async (rootPath: string, filePath: string): Promise<{ success: boolean } | null> => {
    const api = getAPI();
    if (!api) {
      return null;
    }
    return api.stageFile(rootPath, filePath);
  },

  /** Unstage a file (git reset HEAD) */
  unstageFile: async (rootPath: string, filePath: string): Promise<{ success: boolean } | null> => {
    const api = getAPI();
    if (!api) {
      return null;
    }
    return api.unstageFile(rootPath, filePath);
  },

  /** Create a commit */
  commit: async (rootPath: string, message: string): Promise<{ success: boolean; error?: string } | null> => {
    const api = getAPI();
    if (!api) {
      return null;
    }
    return api.commit(rootPath, message);
  },

  /** Get staged diff for commit message generation */
  getStagedDiff: async (rootPath: string): Promise<{ stagedFiles: string[]; diff: string } | null> => {
    const api = getAPI();
    if (!api) {
      return null;
    }
    return api.getStagedDiff(rootPath);
  },

  /** Generate a commit message using Claude */
  generateCommitMessage: async (rootPath: string): Promise<{ message: string; error?: string } | null> => {
    const api = getAPI();
    if (!api) {
      return null;
    }
    return api.generateCommitMessage(rootPath);
  },
};
