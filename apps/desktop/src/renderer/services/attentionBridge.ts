import type { AttentionChange, AttentionState } from '../../shared/attention';

/**
 * Attention Bridge - Isolates all window.attentionAPI access to this single file.
 */

function getAPI() {
  if (typeof window !== 'undefined' && window.attentionAPI) {
    return window.attentionAPI;
  }
  return null;
}

export const attentionBridge = {
  /** Every session's record and derived attention; empty when the API is unavailable. */
  getSnapshot: async (): Promise<AttentionState> => {
    const api = getAPI();
    if (!api) {
      return { records: {}, attention: {} };
    }
    return api.getSnapshot();
  },

  /** Hear what changed. Returns the unsubscribe. */
  onChanged: (callback: (change: AttentionChange) => void): (() => void) => {
    return getAPI()?.onChanged(callback) ?? (() => {});
  },

  /** The session this window is showing, or null when it shows none. */
  setViewing: (instanceId: string | null): void => {
    getAPI()?.setViewing(instanceId);
  },

  /** Whether this window has focus. Main decides what counts as seen from this and `setViewing`. */
  setFocused: (focused: boolean): void => {
    getAPI()?.setFocused(focused);
  },
};
