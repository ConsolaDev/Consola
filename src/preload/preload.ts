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
    HarnessLaunchFields,
    HarnessProbeResult,
} from '../shared/types';
import { IPC_CHANNELS } from '../shared/constants';

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

// Expose harness queries to the renderer
contextBridge.exposeInMainWorld('harnessAPI', {
    probe: (fields: HarnessLaunchFields): Promise<HarnessProbeResult> => {
        return ipcRenderer.invoke(IPC_CHANNELS.HARNESS_PROBE, fields);
    },

    getSessionName: (
        sessionId: string,
        fields: HarnessLaunchFields
    ): Promise<string | null> => {
        return ipcRenderer.invoke(IPC_CHANNELS.HARNESS_SESSION_NAME, sessionId, fields);
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
    generateCommitMessage: (rootPath: string): Promise<{ message: string; error?: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GENERATE_COMMIT_MESSAGE, { rootPath });
    },
});

// Session storage types
