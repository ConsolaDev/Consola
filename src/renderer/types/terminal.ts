export type TerminalMode = 'SHELL' | 'CLAUDE' | 'AGENT';

export type DataCallback = (data: string) => void;
export type ModeCallback = (mode: TerminalMode) => void;

export interface TerminalAPI {
  sendInput: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  switchMode: (mode: TerminalMode) => void;
  onData: (callback: DataCallback) => void;
  onModeChanged: (callback: ModeCallback) => void;
  removeDataListener: (callback: DataCallback) => void;
  removeModeChangedListener: (callback: ModeCallback) => void;
}

declare global {
  interface Window {
    terminalAPI: TerminalAPI;
  }
}
