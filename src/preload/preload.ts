import { contextBridge, ipcRenderer } from 'electron';
import { TerminalMode } from '../shared/types';
import { IPC_CHANNELS } from '../shared/constants';

// Type for callback functions
type DataCallback = (data: string) => void;
type ModeCallback = (mode: TerminalMode) => void;

// Store callbacks for removal
const dataCallbacks: Set<DataCallback> = new Set();
const modeCallbacks: Set<ModeCallback> = new Set();

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
