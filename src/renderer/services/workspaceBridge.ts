import type { WorkspaceSnapshot } from '../../shared/types';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';

/**
 * Bridge to the workspace records owned by the main process.
 *
 * Every call here is an intent, never a whole-state write: main applies it and
 * broadcasts the result, so two windows mutating at once cannot lose a record.
 */
export const workspaceBridge = {
    getSnapshot(): Promise<WorkspaceSnapshot> {
        return window.workspaceAPI.getSnapshot();
    },

    /** One-time handoff of the pre-main localStorage state. */
    importState(workspaces: Workspace[], version: number): Promise<boolean> {
        return window.workspaceAPI.importState(workspaces, version);
    },

    createWorkspace(
        name: string,
        path: string,
        isGitRepo: boolean,
        defaultHarnessId?: string
    ): Promise<Workspace> {
        return window.workspaceAPI.createWorkspace(name, path, isGitRepo, defaultHarnessId);
    },

    updateWorkspace(
        id: string,
        updates: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>>
    ): Promise<void> {
        return window.workspaceAPI.updateWorkspace(id, updates);
    },

    deleteWorkspace(id: string): Promise<void> {
        return window.workspaceAPI.deleteWorkspace(id);
    },

    createSession(workspaceId: string, fields: NewSessionFields): Promise<Session | undefined> {
        return window.workspaceAPI.createSession(workspaceId, fields);
    },

    updateSession(
        workspaceId: string,
        sessionId: string,
        updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>
    ): Promise<void> {
        return window.workspaceAPI.updateSession(workspaceId, sessionId, updates);
    },

    deleteSession(workspaceId: string, sessionId: string): Promise<void> {
        return window.workspaceAPI.deleteSession(workspaceId, sessionId);
    },

    onChanged(callback: (workspaces: Workspace[]) => void): () => void {
        return window.workspaceAPI.onChanged(callback);
    },
};
