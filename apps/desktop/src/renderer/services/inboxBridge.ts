import type { InboxSnapshot } from '../../shared/workItems';

function getAPI() {
    if (typeof window !== 'undefined' && window.inboxAPI) {
        return window.inboxAPI;
    }
    return null;
}

/**
 * Bridge to the Inbox cache in the main process.
 *
 * Main owns the cache; this bridge sends intents and listens for pushes.
 * Read-only against the provider by construction: nothing here writes to it.
 */
export const inboxBridge = {
    /** Cached snapshot, or null. A null result also kicks a background refresh. */
    getInbox: async (workspaceId: string): Promise<InboxSnapshot | null> => {
        const api = getAPI();
        if (!api) return null;
        return api.getInbox(workspaceId);
    },

    /** Manual refresh; the result arrives on `onInboxChanged`. */
    refreshInbox: async (workspaceId: string): Promise<void> => {
        const api = getAPI();
        if (!api) return;
        await api.refreshInbox(workspaceId);
    },

    onInboxChanged: (callback: (snapshot: InboxSnapshot) => void): (() => void) => {
        const api = getAPI();
        if (!api) return () => {};
        return api.onInboxChanged(callback);
    },
};
