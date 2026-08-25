import type {
    WorkspaceSnapshot,
    SessionFanOutIntent,
    SessionFanOutResult,
    ScopeRepo,
} from '../../shared/types';
import type { InboxSection } from '../../shared/inboxSections';
import type { WorkItemAction } from '../../shared/workItemActions';
import type {
    Group,
    NewGroupFields,
    NewScopeFields,
    NewSessionFields,
    Scope,
    Session,
    SessionUpdates,
    Workspace,
    WorkspaceProvider,
} from '../../shared/workspace';

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

    updateSession(workspaceId: string, sessionId: string, updates: SessionUpdates): Promise<void> {
        return window.workspaceAPI.updateSession(workspaceId, sessionId, updates);
    },

    deleteSession(workspaceId: string, sessionId: string): Promise<void> {
        return window.workspaceAPI.deleteSession(workspaceId, sessionId);
    },

    addScope(workspaceId: string, fields: NewScopeFields): Promise<Scope> {
        return window.workspaceAPI.addScope(workspaceId, fields);
    },

    updateScope(
        workspaceId: string,
        scopeId: string,
        updates: Partial<Pick<Scope, 'name'>>
    ): Promise<void> {
        return window.workspaceAPI.updateScope(workspaceId, scopeId, updates);
    },

    /** Rejects while any session still references the scope. */
    removeScope(workspaceId: string, scopeId: string): Promise<void> {
        return window.workspaceAPI.removeScope(workspaceId, scopeId);
    },

    setProviderBinding(workspaceId: string, binding: WorkspaceProvider | null): Promise<void> {
        return window.workspaceAPI.setProviderBinding(workspaceId, binding);
    },

    /** Replaces actions and section defaults in one validated write; rejects with the message. */
    setActions(
        workspaceId: string,
        actions: WorkItemAction[],
        sectionDefaults: Partial<Record<InboxSection, string>>
    ): Promise<void> {
        return window.workspaceAPI.setActions(workspaceId, actions, sectionDefaults);
    },

    createGroup(workspaceId: string, fields: NewGroupFields): Promise<Group> {
        return window.workspaceAPI.createGroup(workspaceId, fields);
    },

    updateGroup(
        workspaceId: string,
        groupId: string,
        updates: Partial<Pick<Group, 'name'>>
    ): Promise<void> {
        return window.workspaceAPI.updateGroup(workspaceId, groupId, updates);
    },

    archiveGroup(workspaceId: string, groupId: string): Promise<void> {
        return window.workspaceAPI.archiveGroup(workspaceId, groupId);
    },

    restoreGroup(workspaceId: string, groupId: string): Promise<void> {
        return window.workspaceAPI.restoreGroup(workspaceId, groupId);
    },

    /** Fan one prompt out across target repos: N sessions in a fresh group. */
    fanOut(intent: SessionFanOutIntent): Promise<SessionFanOutResult> {
        return window.workspaceAPI.fanOut(intent);
    },

    /** The git repos a fan-out can target inside a scope. */
    listScopeRepos(workspaceId: string, scopeId: string): Promise<ScopeRepo[]> {
        return window.workspaceAPI.listScopeRepos(workspaceId, scopeId);
    },

    onChanged(callback: (workspaces: Workspace[]) => void): () => void {
        return window.workspaceAPI.onChanged(callback);
    },
};
