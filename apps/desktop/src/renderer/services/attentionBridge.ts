import type { AttentionSnapshot } from '../../shared/attention';

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
  /** Every session's recorded activity; empty when the API is unavailable. */
  getSnapshot: async (): Promise<AttentionSnapshot> => {
    const api = getAPI();
    if (!api) {
      return {};
    }
    return api.getSnapshot();
  },
};
