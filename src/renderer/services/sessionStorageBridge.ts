import type { PersistedSessionData } from '../types/electron';

/**
 * Session Storage Bridge - Isolates all window.sessionStorageAPI access to this single file.
 *
 * Why: Electron's contextBridge can only expose APIs on the window object.
 * This bridge wraps that access so the rest of the app doesn't touch window directly.
 */

function getAPI() {
  if (typeof window !== 'undefined' && window.sessionStorageAPI) {
    return window.sessionStorageAPI;
  }
  return null;
}

export const sessionStorageBridge = {
  /** Check if the session storage API is available */
  isAvailable: (): boolean => {
    return getAPI() !== null;
  },

  /** Save session history */
  saveHistory: async (sessionId: string, data: PersistedSessionData): Promise<void> => {
    const api = getAPI();
    if (api) {
      await api.saveHistory(sessionId, data);
    }
  },

  /** Load session history */
  loadHistory: async (sessionId: string): Promise<PersistedSessionData | null> => {
    const api = getAPI();
    if (!api) {
      return null;
    }
    return api.loadHistory(sessionId);
  },

  /** Delete session history */
  deleteHistory: async (sessionId: string): Promise<void> => {
    const api = getAPI();
    if (api) {
      await api.deleteHistory(sessionId);
    }
  },

  /** Generate a name from a query */
  generateName: async (query: string): Promise<string | null> => {
    const api = getAPI();
    if (!api) {
      return null;
    }
    const result = await api.generateName(query);
    return result.name;
  },
};
