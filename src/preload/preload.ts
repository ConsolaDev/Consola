import { contextBridge, ipcRenderer } from 'electron';
import {
    TerminalMode,
    AgentQueryOptions,
    AgentStatus,
    AgentInitEvent,
    AgentMessageEvent,
    AgentToolEvent,
    AgentResultEvent
} from '../shared/types';
import { IPC_CHANNELS } from '../shared/constants';

// Type for callback functions
type DataCallback = (data: string) => void;
type ModeCallback = (mode: TerminalMode) => void;

// Store callbacks for removal
const dataCallbacks: Set<DataCallback> = new Set();
const modeCallbacks: Set<ModeCallback> = new Set();

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

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('terminalAPI', {
    // Send user input to the PTY
    sendInput: (data: string): void => {
        ipcRenderer.send(IPC_CHANNELS.TERMINAL_INPUT, data);
    },

    // Resize the terminal
    resize: (cols: number, rows: number): void => {
        ipcRenderer.send(IPC_CHANNELS.TERMINAL_RESIZE, cols, rows);
    },

    // Switch terminal mode
    switchMode: (mode: TerminalMode): void => {
        ipcRenderer.send(IPC_CHANNELS.MODE_SWITCH, mode);
    },

    // Listen for terminal data from PTY
    onData: (callback: DataCallback): void => {
        const wrappedCallback = (_event: Electron.IpcRendererEvent, data: string) => {
            callback(data);
        };
        dataCallbacks.add(callback);
        ipcRenderer.on(IPC_CHANNELS.TERMINAL_DATA, wrappedCallback);
    },

    // Listen for mode changes
    onModeChanged: (callback: ModeCallback): void => {
        const wrappedCallback = (_event: Electron.IpcRendererEvent, mode: TerminalMode) => {
            callback(mode);
        };
        modeCallbacks.add(callback);
        ipcRenderer.on(IPC_CHANNELS.MODE_CHANGED, wrappedCallback);
    },

    // Remove data listener
    removeDataListener: (callback: DataCallback): void => {
        dataCallbacks.delete(callback);
        ipcRenderer.removeAllListeners(IPC_CHANNELS.TERMINAL_DATA);
        // Re-add remaining callbacks
        for (const cb of dataCallbacks) {
            ipcRenderer.on(IPC_CHANNELS.TERMINAL_DATA, (_event, data) => cb(data));
        }
    },

    // Remove mode changed listener
    removeModeChangedListener: (callback: ModeCallback): void => {
        modeCallbacks.delete(callback);
        ipcRenderer.removeAllListeners(IPC_CHANNELS.MODE_CHANGED);
        // Re-add remaining callbacks
        for (const cb of modeCallbacks) {
            ipcRenderer.on(IPC_CHANNELS.MODE_CHANGED, (_event, mode) => cb(mode));
        }
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
});

// Expose File API to renderer
contextBridge.exposeInMainWorld('fileAPI', {
    readFile: (filePath: string): Promise<string> => {
        return ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, filePath);
    },
});
