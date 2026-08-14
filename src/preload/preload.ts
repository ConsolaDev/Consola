import { contextBridge, ipcRenderer } from 'electron';
import {
    TerminalMode,
    TerminalCreateOptions,
    TerminalSnapshot,
    TerminalDataMessage,
    TerminalModeChangedMessage,
    TerminalActivityMessage,
    TerminalAwaitingConfirmationMessage,
    TerminalExitMessage,
    AgentQueryOptions,
    AgentStatus,
    AgentInitEvent,
    AgentMessageEvent,
    AgentToolEvent,
    AgentResultEvent,
    AgentInputRequest,
    AgentInputResponse,
    SessionEndEvent,
    SessionStartEvent,
    TrustMode,
    TrustModeChangedEvent
} from '../shared/types';
import { IPC_CHANNELS } from '../shared/constants';

// Claude Agent callback storage
type AgentCallback<T> = (data: T) => void;

const agentCallbacks = {
    init: new Set<AgentCallback<AgentInitEvent>>(),
    assistantMessage: new Set<AgentCallback<AgentMessageEvent>>(),
    stream: new Set<AgentCallback<unknown>>(),
    toolPending: new Set<AgentCallback<AgentToolEvent>>(),
    toolComplete: new Set<AgentCallback<AgentToolEvent>>(),
    result: new Set<AgentCallback<AgentResultEvent>>(),
    error: new Set<AgentCallback<{ instanceId: string; message: string }>>(),
    statusChanged: new Set<AgentCallback<AgentStatus & { instanceId: string }>>(),
    notification: new Set<AgentCallback<{ instanceId: string; message: string; title?: string }>>(),
    inputRequest: new Set<AgentCallback<AgentInputRequest>>(),
    sessionEnd: new Set<AgentCallback<SessionEndEvent>>(),
    sessionStart: new Set<AgentCallback<SessionStartEvent>>(),
    trustModeChanged: new Set<AgentCallback<TrustModeChangedEvent>>(),
};

// Register agent IPC listeners
ipcRenderer.on(IPC_CHANNELS.AGENT_INIT, (_event, data: AgentInitEvent) => {
    agentCallbacks.init.forEach(cb => cb(data));
});

ipcRenderer.on(IPC_CHANNELS.AGENT_ASSISTANT_MESSAGE, (_event, data: AgentMessageEvent) => {
    agentCallbacks.assistantMessage.forEach(cb => cb(data));
});

ipcRenderer.on(IPC_CHANNELS.AGENT_STREAM, (_event, data: unknown) => {
    agentCallbacks.stream.forEach(cb => cb(data));
});

ipcRenderer.on(IPC_CHANNELS.AGENT_TOOL_PENDING, (_event, data: AgentToolEvent) => {
    agentCallbacks.toolPending.forEach(cb => cb(data));
});

ipcRenderer.on(IPC_CHANNELS.AGENT_TOOL_COMPLETE, (_event, data: AgentToolEvent) => {
    agentCallbacks.toolComplete.forEach(cb => cb(data));
});

ipcRenderer.on(IPC_CHANNELS.AGENT_RESULT, (_event, data: AgentResultEvent) => {
    agentCallbacks.result.forEach(cb => cb(data));
});

ipcRenderer.on(IPC_CHANNELS.AGENT_ERROR, (_event, data: { instanceId: string; message: string }) => {
    agentCallbacks.error.forEach(cb => cb(data));
});

ipcRenderer.on(IPC_CHANNELS.AGENT_STATUS_CHANGED, (_event, data: AgentStatus & { instanceId: string }) => {
    agentCallbacks.statusChanged.forEach(cb => cb(data));
});

ipcRenderer.on(IPC_CHANNELS.AGENT_NOTIFICATION, (_event, data: { instanceId: string; message: string; title?: string }) => {
    agentCallbacks.notification.forEach(cb => cb(data));
});

ipcRenderer.on(IPC_CHANNELS.AGENT_INPUT_REQUEST, (_event, data: AgentInputRequest) => {
    agentCallbacks.inputRequest.forEach(cb => cb(data));
});

ipcRenderer.on(IPC_CHANNELS.AGENT_SESSION_END, (_event, data: SessionEndEvent) => {
    agentCallbacks.sessionEnd.forEach(cb => cb(data));
});

ipcRenderer.on(IPC_CHANNELS.AGENT_SESSION_START, (_event, data: SessionStartEvent) => {
    agentCallbacks.sessionStart.forEach(cb => cb(data));
});

ipcRenderer.on(IPC_CHANNELS.AGENT_TRUST_MODE_CHANGED, (_event, data: TrustModeChangedEvent) => {
    agentCallbacks.trustModeChanged.forEach(cb => cb(data));
});

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

    // Switch between the claude and shell PTYs
    switchMode: (instanceId: string, mode: TerminalMode): void => {
        ipcRenderer.send(IPC_CHANNELS.TERMINAL_MODE_SWITCH, instanceId, mode);
    },

    // Relaunch claude after it exited
    restart: (instanceId: string): void => {
        ipcRenderer.send(IPC_CHANNELS.TERMINAL_RESTART, instanceId);
    },

    // Tear down a session's terminal
    destroy: (instanceId: string): void => {
        ipcRenderer.send(IPC_CHANNELS.TERMINAL_DESTROY, instanceId);
    },

    onData: (callback: (message: TerminalDataMessage) => void) =>
        subscribe(IPC_CHANNELS.TERMINAL_DATA, callback),

    onModeChanged: (callback: (message: TerminalModeChangedMessage) => void) =>
        subscribe(IPC_CHANNELS.TERMINAL_MODE_CHANGED, callback),

    onActivity: (callback: (message: TerminalActivityMessage) => void) =>
        subscribe(IPC_CHANNELS.TERMINAL_ACTIVITY, callback),

    onAwaitingConfirmation: (callback: (message: TerminalAwaitingConfirmationMessage) => void) =>
        subscribe(IPC_CHANNELS.TERMINAL_AWAITING_CONFIRMATION, callback),

    onExit: (callback: (message: TerminalExitMessage) => void) =>
        subscribe(IPC_CHANNELS.TERMINAL_EXIT, callback),
});

// Expose Claude CLI queries to the renderer
contextBridge.exposeInMainWorld('claudeCliAPI', {
    isAvailable: (): Promise<boolean> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_AVAILABLE);
    },

    getSessionName: (claudeSessionId: string): Promise<string | null> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_SESSION_NAME, claudeSessionId);
    },
});

// Expose Claude Agent API to renderer
contextBridge.exposeInMainWorld('claudeAgentAPI', {
    // === Commands ===

    // Start a new agent query
    startQuery: (options: AgentQueryOptions): void => {
        ipcRenderer.send(IPC_CHANNELS.AGENT_START, options);
    },

    // Interrupt the current query for a specific instance
    interrupt: (instanceId: string): void => {
        ipcRenderer.send(IPC_CHANNELS.AGENT_INTERRUPT, instanceId);
    },

    // Get current agent status for a specific instance
    getStatus: (instanceId: string): Promise<AgentStatus> => {
        return ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_STATUS, instanceId);
    },

    // Destroy an agent instance
    destroyInstance: (instanceId: string): void => {
        ipcRenderer.send(IPC_CHANNELS.AGENT_DESTROY_INSTANCE, instanceId);
    },

    // Respond to an input/permission request
    respondToInput: (response: AgentInputResponse): void => {
        ipcRenderer.send(IPC_CHANNELS.AGENT_INPUT_RESPONSE, response);
    },

    // Initialize session (pre-load skills/commands)
    initialize: (instanceId: string, cwd: string): Promise<{
        skills: string[];
        slashCommands: string[];
        plugins: { name: string; path: string }[];
    }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.AGENT_INITIALIZE, { instanceId, cwd });
    },

    // Set trust mode for session (auto-approve all for session)
    setTrustMode: (instanceId: string, mode: TrustMode): void => {
        ipcRenderer.send(IPC_CHANNELS.AGENT_SET_TRUST_MODE, { instanceId, mode });
    },

    // Get current trust mode
    getTrustMode: (instanceId: string): Promise<{ mode: TrustMode; enabledAt?: number }> => {
        return ipcRenderer.invoke('agent:get-trust-mode', instanceId);
    },

    // === Event Subscriptions ===

    // Listen for session initialization
    onInit: (callback: AgentCallback<AgentInitEvent>): void => {
        agentCallbacks.init.add(callback);
    },

    // Listen for assistant messages
    onAssistantMessage: (callback: AgentCallback<AgentMessageEvent>): void => {
        agentCallbacks.assistantMessage.add(callback);
    },

    // Listen for stream events
    onStream: (callback: AgentCallback<unknown>): void => {
        agentCallbacks.stream.add(callback);
    },

    // Listen for tool pending events
    onToolPending: (callback: AgentCallback<AgentToolEvent>): void => {
        agentCallbacks.toolPending.add(callback);
    },

    // Listen for tool complete events
    onToolComplete: (callback: AgentCallback<AgentToolEvent>): void => {
        agentCallbacks.toolComplete.add(callback);
    },

    // Listen for result events
    onResult: (callback: AgentCallback<AgentResultEvent>): void => {
        agentCallbacks.result.add(callback);
    },

    // Listen for error events
    onError: (callback: AgentCallback<{ instanceId: string; message: string }>): void => {
        agentCallbacks.error.add(callback);
    },

    // Listen for status changes
    onStatusChanged: (callback: AgentCallback<AgentStatus & { instanceId: string }>): void => {
        agentCallbacks.statusChanged.add(callback);
    },

    // Listen for notifications
    onNotification: (callback: AgentCallback<{ instanceId: string; message: string; title?: string }>): void => {
        agentCallbacks.notification.add(callback);
    },

    // Listen for input/permission requests
    onInputRequest: (callback: AgentCallback<AgentInputRequest>): void => {
        agentCallbacks.inputRequest.add(callback);
    },

    // Listen for session end events
    onSessionEnd: (callback: AgentCallback<SessionEndEvent>): void => {
        agentCallbacks.sessionEnd.add(callback);
    },

    // Listen for session start events
    onSessionStart: (callback: AgentCallback<SessionStartEvent>): void => {
        agentCallbacks.sessionStart.add(callback);
    },

    // Listen for trust mode changes
    onTrustModeChanged: (callback: AgentCallback<TrustModeChangedEvent>): void => {
        agentCallbacks.trustModeChanged.add(callback);
    },

    // === Cleanup ===

    // Remove a listener by event name and callback
    removeListener: (event: string, callback: Function): void => {
        const callbackSet = agentCallbacks[event as keyof typeof agentCallbacks];
        if (callbackSet) {
            callbackSet.delete(callback as any);
        }
    },
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
    generateCommitMessage: (rootPath: string, instanceId: string): Promise<{ message: string; error?: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.AGENT_GENERATE_COMMIT_MESSAGE, { rootPath, instanceId });
    },
});

// Session storage types
interface PersistedSessionData {
    messages: unknown[];
    toolHistory: unknown[];
}

// Expose Session Storage API to renderer
contextBridge.exposeInMainWorld('sessionStorageAPI', {
    saveHistory: (sessionId: string, data: PersistedSessionData): Promise<void> => {
        return ipcRenderer.invoke('session:save-history', { sessionId, data });
    },
    loadHistory: (sessionId: string): Promise<PersistedSessionData | null> => {
        return ipcRenderer.invoke('session:load-history', { sessionId });
    },
    deleteHistory: (sessionId: string): Promise<void> => {
        return ipcRenderer.invoke('session:delete-history', { sessionId });
    },
    generateName: (query: string): Promise<{ name: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SESSION_GENERATE_NAME, { query });
    },
});
