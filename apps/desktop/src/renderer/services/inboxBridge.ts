import type { WorkItemRef } from '../../shared/workItems';
import type { WorkItemDetails, WorkItemMutation } from '../../shared/workItemDetails';
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
 * Explicit remote actions are validated and executed in main.
 */
export const inboxBridge = {
    getDetails: async (workspaceId: string, ref: WorkItemRef): Promise<WorkItemDetails> => {
        const api = getAPI();
        if (!api) throw new Error('Inbox connection is unavailable.');
        return api.getDetails(workspaceId, ref);
    },
    mutateItem: async (workspaceId: string, ref: WorkItemRef, mutation: WorkItemMutation): Promise<void> => {
        const api = getAPI();
        if (!api) throw new Error('Inbox connection is unavailable.');
        return api.mutateItem(workspaceId, ref, mutation);
    },
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
