export enum TerminalMode {
    SHELL = 'SHELL',
    CLAUDE = 'CLAUDE'
}

export interface TerminalDimensions {
    cols: number;
    rows: number;
}

export interface TerminalDataMessage {
    instanceId: string;
    data: string;
}

export interface TerminalInputMessage {
    instanceId: string;
    data: string;
}

export interface TerminalResizeMessage {
    instanceId: string;
    cols: number;
    rows: number;
}

export interface ModeSwitchMessage {
    instanceId: string;
    mode: TerminalMode;
}

export interface ModeChangedMessage {
    instanceId: string;
    mode: TerminalMode;
}

export interface TerminalAPI {
    sendInput: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    switchMode: (mode: TerminalMode) => void;
    onData: (callback: (data: string) => void) => void;
    onModeChanged: (callback: (mode: TerminalMode) => void) => void;
    removeDataListener: (callback: (data: string) => void) => void;
    removeModeChangedListener: (callback: (mode: TerminalMode) => void) => void;
}

declare global {
    interface Window {
        terminalAPI: TerminalAPI;
    }
}
