import type { AssistantActivitySnapshot } from '../../shared/types';
import type { Session } from '../../shared/workspace';

/**
 * Bridge to the workspace Assistant owned by the main process.
 *
 * `open` makes the Assistant's record the first time and returns it after;
 * `startFresh` replaces it with a new conversation. Neither launches
 * anything — the pane does, like any other session.
 */
export const assistantBridge = {
    open(workspaceId: string): Promise<Session> {
        return window.assistantAPI.open(workspaceId);
    },
    startFresh(workspaceId: string): Promise<Session> {
        return window.assistantAPI.startFresh(workspaceId);
    },
    /** The sessions the Assistant touched here, and how many finished unseen. */
    getActivity(workspaceId: string): Promise<AssistantActivitySnapshot> {
        return window.assistantAPI.getActivity(workspaceId);
    },
    markSeen(workspaceId: string): Promise<void> {
        return window.assistantAPI.markSeen(workspaceId);
    },
    onActivityChanged(
        callback: (change: { workspaceId: string; activity: AssistantActivitySnapshot }) => void
    ): () => void {
        return window.assistantAPI.onActivityChanged(callback);
    },
};
