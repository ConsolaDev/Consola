import type { ActivateWorkspaceResult, WindowContext } from '../../shared/types';

/**
 * Bridge to this window's identity.
 *
 * `context` is the value this window opened with and never changes; switching
 * goes through `activateWorkspace`, whose verdict decides whether this window
 * took the workspace or another one already had it.
 */
export const windowBridge = {
    get context(): WindowContext {
        return window.windowAPI.context;
    },

    activateWorkspace(workspaceId: string | null): Promise<ActivateWorkspaceResult> {
        return window.windowAPI.activateWorkspace(workspaceId);
    },

    openWindow(workspaceId: string | null): Promise<void> {
        return window.windowAPI.openWindow(workspaceId);
    },

    /** Remembered by main so a relaunch reopens on the same session. */
    setActiveSession(sessionId: string | null): void {
        window.windowAPI.setActiveSession(sessionId);
    },

    onWorkspaceChanged(callback: (workspaceId: string | null) => void): () => void {
        return window.windowAPI.onWorkspaceChanged(callback);
    },
};
