import type { AttentionChange, AttentionState } from '../../shared/attention';
import type { SettleMemento, SettleResult } from '../../shared/preferences';

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

  /** Settle a session and everything beneath it. Says whether it reached the shelf; the memento is what `restore` undoes it with. */
  settle: async (workspaceId: string, sessionId: string): Promise<SettleResult> =>
    (await getAPI()?.settle(workspaceId, sessionId)) ?? { settled: false, memento: {} },

  /** Bring a session back to the list; auto-settle leaves it alone until it has new activity. */
  unsettle: async (workspaceId: string, sessionId: string): Promise<SettleMemento> =>
    (await getAPI()?.unsettle(workspaceId, sessionId)) ?? {},

  /** Put the ledger back as a memento recorded it. */
  restore: async (memento: SettleMemento): Promise<void> => {
    await getAPI()?.restore(memento);
  },
};
