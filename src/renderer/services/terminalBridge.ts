import type { TerminalMode, DataCallback, ModeCallback } from '../types/terminal';

/**
 * Terminal Bridge - Isolates all window.terminalAPI access to this single file.
 *
 * Why: Electron's contextBridge can only expose APIs on the window object.
 * This bridge wraps that access so the rest of the app doesn't touch window directly.
 */

function getAPI() {
  return window.terminalAPI;
}

export const terminalBridge = {
  /** Check if the terminal API is available */
  isAvailable: (): boolean => {
    return !!getAPI();
  },

  /** Send input data to the PTY */
  sendInput: (data: string): void => {
    getAPI()?.sendInput(data);
  },

  /** Resize the PTY */
  resize: (cols: number, rows: number): void => {
    getAPI()?.resize(cols, rows);
  },

  /** Switch between SHELL and CLAUDE modes */
  switchMode: (mode: TerminalMode): void => {
    getAPI()?.switchMode(mode);
  },

  /** Subscribe to PTY data output */
  onData: (callback: DataCallback): void => {
    getAPI()?.onData(callback);
  },

  /** Subscribe to mode change events */
  onModeChanged: (callback: ModeCallback): void => {
    getAPI()?.onModeChanged(callback);
  },

  /** Unsubscribe from PTY data output */
  removeDataListener: (callback: DataCallback): void => {
    getAPI()?.removeDataListener(callback);
  },

  /** Unsubscribe from mode change events */
  removeModeChangedListener: (callback: ModeCallback): void => {
    getAPI()?.removeModeChangedListener(callback);
  },
};
