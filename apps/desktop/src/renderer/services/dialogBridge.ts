import type { FolderInfo } from '../types/electron';

/**
 * Dialog Bridge - Isolates all window.dialogAPI access to this single file.
 *
 * Why: Electron's contextBridge can only expose APIs on the window object.
 * This bridge wraps that access so the rest of the app doesn't touch window directly.
 */

function getAPI() {
  if (typeof window !== 'undefined' && window.dialogAPI) {
    return window.dialogAPI;
  }
  return null;
}

export const dialogBridge = {
  /** Check if the dialog API is available */
  isAvailable: (): boolean => {
    return getAPI() !== null;
  },

  /** Open a folder selection dialog (single folder) */
  selectFolder: async (): Promise<FolderInfo | null> => {
    const api = getAPI();
    if (!api) {
      return null;
    }
    return api.selectFolder();
  },

  /** Open a folder selection dialog (multiple folders) */
  selectFolders: async (): Promise<FolderInfo[]> => {
    const api = getAPI();
    if (!api) {
      return [];
    }
    return api.selectFolders();
  },
};
