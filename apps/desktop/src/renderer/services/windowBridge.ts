import type { ActivateWorkspaceResult, WindowContext, WorkspaceView } from '../../shared/types';

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

    /**
     * Report what this window is showing.
     *
     * Remembered by main against the workspace, so switching away and back —
     * or relaunching — returns to it. The pair travels together because the
     * Inbox overlays the pane without clearing the session behind it.
     */
    setView(workspaceId: string | null, view: WorkspaceView): void {
        window.windowAPI.setView(workspaceId, view);
    },

    onWorkspaceChanged(callback: (workspaceId: string | null) => void): () => void {
        return window.windowAPI.onWorkspaceChanged(callback);
    },

    /** A notification click chose a session in this window's workspace. */
    onActivateSession(callback: (sessionId: string) => void): () => void {
        return window.windowAPI.onActivateSession(callback);
    },
};
