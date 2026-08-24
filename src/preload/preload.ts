import { contextBridge, ipcRenderer } from 'electron';
import {
    TerminalCreateOptions,
    TerminalSnapshot,
    TerminalDataMessage,
    TerminalActivityMessage,
    TerminalAwaitingConfirmationMessage,
    TerminalExitMessage,
    TerminalStatusMessage,
    TerminalStatusSnapshot,
    HarnessLaunchFields,
    HarnessCapabilitiesResult,
    HarnessProbeResult,
    SessionNameResult,
    WorkspaceSnapshot,
    WindowContext,
    ActivateWorkspaceResult,
    WorkItemLaunchResult,
    CloneRepoResult,
    SessionFanOutIntent,
    SessionFanOutResult,
    ScopeRepo,
    ConductorCreateRequest,
} from '../shared/types';
import { IPC_CHANNELS } from '../shared/constants';
import type { GhProbeResult, InboxSnapshot, WorkItemRef } from '../shared/github';
import type {
    Group,
    NewGroupFields,
    NewScopeFields,
    NewSessionFields,
    Scope,
    Session,
    Workspace,
} from '../shared/workspace';
import type { Harness, HarnessUpdates, NewHarnessFields } from '../shared/harness';

// Subscribe to a main->renderer channel, returning an unsubscribe function so
// callers never have to re-register their peers to remove one listener.
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('terminalAPI', {
    // Start or attach to a session's terminal
    create: (options: TerminalCreateOptions): Promise<TerminalSnapshot> => {
        return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, options);
    },

    // Send user input to the PTY
    sendInput: (instanceId: string, data: string): void => {
        ipcRenderer.send(IPC_CHANNELS.TERMINAL_INPUT, instanceId, data);
    },

    // Paste a block of text as a single unit
    paste: (instanceId: string, text: string): void => {
        ipcRenderer.send(IPC_CHANNELS.TERMINAL_PASTE, instanceId, text);
    },

    // Resize the terminal
    resize: (instanceId: string, cols: number, rows: number): void => {
        ipcRenderer.send(IPC_CHANNELS.TERMINAL_RESIZE, instanceId, cols, rows);
    },

    // Relaunch claude after it exited
    restart: (instanceId: string): void => {
        ipcRenderer.send(IPC_CHANNELS.TERMINAL_RESTART, instanceId);
    },

    // Tear down a session's terminal
    destroy: (instanceId: string): void => {
        ipcRenderer.send(IPC_CHANNELS.TERMINAL_DESTROY, instanceId);
    },

    // Live status of every terminal, for a window that missed the edges
    getStatusSnapshot: (): Promise<TerminalStatusSnapshot> => {
        return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_STATUS_SNAPSHOT);
    },

    onData: (callback: (message: TerminalDataMessage) => void) =>
        subscribe(IPC_CHANNELS.TERMINAL_DATA, callback),

    onActivity: (callback: (message: TerminalActivityMessage) => void) =>
        subscribe(IPC_CHANNELS.TERMINAL_ACTIVITY, callback),

    onAwaitingConfirmation: (callback: (message: TerminalAwaitingConfirmationMessage) => void) =>
        subscribe(IPC_CHANNELS.TERMINAL_AWAITING_CONFIRMATION, callback),

    onExit: (callback: (message: TerminalExitMessage) => void) =>
        subscribe(IPC_CHANNELS.TERMINAL_EXIT, callback),

    onStatus: (callback: (message: TerminalStatusMessage) => void) =>
        subscribe(IPC_CHANNELS.TERMINAL_STATUS, callback),
});

// Expose harness queries to the renderer
contextBridge.exposeInMainWorld('harnessAPI', {
    probe: (fields: HarnessLaunchFields): Promise<HarnessProbeResult> => {
        return ipcRenderer.invoke(IPC_CHANNELS.HARNESS_PROBE, fields);
    },

    getSessionName: (
        sessionId: string,
        fields: HarnessLaunchFields
    ): Promise<SessionNameResult | null> => {
        return ipcRenderer.invoke(IPC_CHANNELS.HARNESS_SESSION_NAME, sessionId, fields);
    },

    getCapabilities: (fields: HarnessLaunchFields): Promise<HarnessCapabilitiesResult> => {
        return ipcRenderer.invoke(IPC_CHANNELS.HARNESS_CAPABILITIES, fields);
    },
});

// Expose GitHub probing to the renderer. Probe only: tokens never cross this
// bridge — they are borrowed and consumed entirely inside the main process.
contextBridge.exposeInMainWorld('githubAPI', {
    probe: (): Promise<GhProbeResult> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GH_PROBE);
    },

    getInbox: (workspaceId: string): Promise<InboxSnapshot | null> =>
        ipcRenderer.invoke(IPC_CHANNELS.GITHUB_GET_INBOX, workspaceId),

    refreshInbox: (workspaceId: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.GITHUB_REFRESH_INBOX, workspaceId),

    resolveRepos: (workspaceId: string, repos: string[]): Promise<Record<string, string | null>> =>
        ipcRenderer.invoke(IPC_CHANNELS.GITHUB_RESOLVE_REPOS, workspaceId, repos),

    launchWorkItem: (workspaceId: string, workItem: WorkItemRef): Promise<WorkItemLaunchResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.GITHUB_LAUNCH_WORK_ITEM, workspaceId, workItem),

    cloneRepo: (
        workspaceId: string,
        repo: string,
        destinationDir: string
    ): Promise<CloneRepoResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.GITHUB_CLONE_REPO, workspaceId, repo, destinationDir),

    onInboxChanged: (callback: (snapshot: InboxSnapshot) => void) =>
        subscribe<InboxSnapshot>(IPC_CHANNELS.GITHUB_INBOX_CHANGED, callback),
});

// Expose workspace state to the renderer. Main owns the records; the renderer
// sends intents and listens for the result.
contextBridge.exposeInMainWorld('workspaceAPI', {
    getSnapshot: (): Promise<WorkspaceSnapshot> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_SNAPSHOT),

    importState: (workspaces: Workspace[], version: number): Promise<boolean> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_IMPORT, workspaces, version),

    createWorkspace: (
        name: string,
        path: string,
        isGitRepo: boolean,
        defaultHarnessId?: string
    ): Promise<Workspace> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, name, path, isGitRepo, defaultHarnessId),

    updateWorkspace: (
        id: string,
        updates: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>>
    ): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE, id, updates),

    deleteWorkspace: (id: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DELETE, id),

    createSession: (workspaceId: string, fields: NewSessionFields): Promise<Session | undefined> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SESSION_CREATE, workspaceId, fields),

    updateSession: (
        workspaceId: string,
        sessionId: string,
        updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted' | 'groupId'>>
    ): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SESSION_UPDATE, workspaceId, sessionId, updates),

    deleteSession: (workspaceId: string, sessionId: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SESSION_DELETE, workspaceId, sessionId),

    addScope: (workspaceId: string, fields: NewScopeFields): Promise<Scope> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ADD_SCOPE, workspaceId, fields),

    updateScope: (
        workspaceId: string,
        scopeId: string,
        updates: Partial<Pick<Scope, 'name'>>
    ): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE_SCOPE, workspaceId, scopeId, updates),

    removeScope: (workspaceId: string, scopeId: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE_SCOPE, workspaceId, scopeId),

    setGitHubBinding: (
        workspaceId: string,
        binding: { accountLogin: string; org?: string } | null
    ): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SET_GITHUB_BINDING, workspaceId, binding),

    createGroup: (workspaceId: string, fields: NewGroupFields): Promise<Group> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GROUP_CREATE, workspaceId, fields),

    updateGroup: (
        workspaceId: string,
        groupId: string,
        updates: Partial<Pick<Group, 'name'>>
    ): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GROUP_UPDATE, workspaceId, groupId, updates),

    archiveGroup: (workspaceId: string, groupId: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GROUP_ARCHIVE, workspaceId, groupId),

    restoreGroup: (workspaceId: string, groupId: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GROUP_RESTORE, workspaceId, groupId),

    fanOut: (intent: SessionFanOutIntent): Promise<SessionFanOutResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.SESSION_FAN_OUT, intent),

    listScopeRepos: (workspaceId: string, scopeId: string): Promise<ScopeRepo[]> =>
        ipcRenderer.invoke(IPC_CHANNELS.SCOPE_LIST_REPOS, workspaceId, scopeId),

    onChanged: (callback: (workspaces: Workspace[]) => void) =>
        subscribe<Workspace[]>(IPC_CHANNELS.WORKSPACE_CHANGED, callback),
});

// Conductor orchestration: one intent. The conductor itself is an ordinary
// session and rides the terminal and workspace APIs above.
contextBridge.exposeInMainWorld('conductorAPI', {
    create: (request: ConductorCreateRequest): Promise<Group> =>
        ipcRenderer.invoke(IPC_CHANNELS.CONDUCTOR_CREATE, request),
});

// Expose harness state to the renderer. Main owns the records; the renderer
// sends intents and listens for the result. Separate from `harnessAPI`, which
// probes health: a probe result is a live fact and is never persisted.
contextBridge.exposeInMainWorld('harnessStateAPI', {
    getSnapshot: (): Promise<{ harnesses: Harness[]; needsImport: boolean }> =>
        ipcRenderer.invoke(IPC_CHANNELS.HARNESS_GET_SNAPSHOT),

    importState: (harnesses: Harness[]): Promise<boolean> =>
        ipcRenderer.invoke(IPC_CHANNELS.HARNESS_IMPORT, harnesses),

    addHarness: (input: NewHarnessFields): Promise<Harness> =>
        ipcRenderer.invoke(IPC_CHANNELS.HARNESS_ADD, input),

    updateHarness: (id: string, updates: HarnessUpdates): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.HARNESS_UPDATE, id, updates),

    archiveHarness: (id: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.HARNESS_ARCHIVE, id),

    restoreHarness: (id: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.HARNESS_RESTORE, id),

    onChanged: (callback: (harnesses: Harness[]) => void) =>
        subscribe<Harness[]>(IPC_CHANNELS.HARNESS_CHANGED, callback),
});

// Expose Dialog API to renderer
contextBridge.exposeInMainWorld('dialogAPI', {
    selectFolders: (): Promise<Array<{ path: string; name: string; isGitRepo: boolean }>> => {
        return ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FOLDERS);
    },
    selectFolder: (): Promise<{ path: string; name: string; isGitRepo: boolean } | null> => {
        return ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FOLDER);
    },
});

// Expose File API to renderer
contextBridge.exposeInMainWorld('fileAPI', {
    readFile: (filePath: string): Promise<string> => {
        return ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, filePath);
    },
    listDirectory: (dirPath: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> => {
        return ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST_DIRECTORY, dirPath);
    },
});

// Git status result types
interface GitStatusResult {
    files: Array<{ path: string; status: 'staged' | 'modified' | 'untracked' | 'deleted' }>;
    stats: { modifiedCount: number; addedLines: number; removedLines: number };
    isGitRepo: boolean;
}

// Git diff result types
interface GitDiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: Array<{
        type: 'context' | 'add' | 'remove';
        content: string;
        oldLineNumber?: number;
        newLineNumber?: number;
    }>;
}

interface GitDiffResult {
    filePath: string;
    staged: boolean;
    oldContent: string;
    newContent: string;
    hunks: GitDiffHunk[];
    isBinary: boolean;
    isNew: boolean;
    isDeleted: boolean;
}

// Expose Git API to renderer
contextBridge.exposeInMainWorld('gitAPI', {
    getStatus: (rootPath: string): Promise<GitStatusResult> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GIT_GET_STATUS, rootPath);
    },
    getDiff: (rootPath: string, filePath: string, staged: boolean): Promise<GitDiffResult> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GIT_GET_DIFF, { rootPath, filePath, staged });
    },
    stageFile: (rootPath: string, filePath: string): Promise<{ success: boolean }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GIT_STAGE_FILE, { rootPath, filePath });
    },
    unstageFile: (rootPath: string, filePath: string): Promise<{ success: boolean }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GIT_UNSTAGE_FILE, { rootPath, filePath });
    },
    commit: (rootPath: string, message: string): Promise<{ success: boolean; error?: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT, { rootPath, message });
    },
    getStagedDiff: (rootPath: string): Promise<{ stagedFiles: string[]; diff: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GIT_GET_STAGED_DIFF, { rootPath });
    },
    generateCommitMessage: (rootPath: string): Promise<{ message: string; error?: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GENERATE_COMMIT_MESSAGE, { rootPath });
    },
});

/**
 * The workspace this window opened on.
 *
 * Passed as a launch argument rather than fetched, so the renderer's very first
 * render already knows what it is looking at.
 */
function readWindowContext(): WindowContext {
    const prefix = '--consola-window=';
    const arg = process.argv.find((value) => value.startsWith(prefix));
    if (!arg) return { workspaceId: null, activeSessionId: null };
    try {
        return JSON.parse(arg.slice(prefix.length)) as WindowContext;
    } catch {
        return { workspaceId: null, activeSessionId: null };
    }
}

contextBridge.exposeInMainWorld('windowAPI', {
    context: readWindowContext(),

    activateWorkspace: (workspaceId: string | null): Promise<ActivateWorkspaceResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.WINDOW_ACTIVATE_WORKSPACE, workspaceId),

    openWindow: (workspaceId: string | null): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WINDOW_OPEN, workspaceId),

    setActiveSession: (sessionId: string | null): void => {
        ipcRenderer.send(IPC_CHANNELS.WINDOW_SET_ACTIVE_SESSION, sessionId);
    },

    onWorkspaceChanged: (callback: (workspaceId: string | null) => void) =>
        subscribe<string | null>(IPC_CHANNELS.WINDOW_WORKSPACE_CHANGED, callback),

    onActivateSession: (callback: (sessionId: string) => void) =>
        subscribe<string>(IPC_CHANNELS.WINDOW_ACTIVATE_SESSION, callback),
});

// Session storage types
