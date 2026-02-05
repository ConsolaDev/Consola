import type { GitStatusResult } from '../types/electron';

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
};
