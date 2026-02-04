/**
 * File Bridge - Isolates all window.fileAPI access to this single file.
 *
 * Why: Electron's contextBridge can only expose APIs on the window object.
 * This bridge wraps that access so the rest of the app doesn't touch window directly.
 */

function getAPI() {
  if (typeof window !== 'undefined' && window.fileAPI) {
    return window.fileAPI;
  }
  return null;
}

export const fileBridge = {
  /** Check if the file API is available */
  isAvailable: (): boolean => {
    return getAPI() !== null;
  },

  /** Read a file from disk */
  readFile: async (filePath: string): Promise<string> => {
    const api = getAPI();
    if (!api) {
      throw new Error('File API not available');
    }
    return api.readFile(filePath);
  },
};
