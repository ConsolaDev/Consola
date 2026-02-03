// Terminal mode enum
export enum TerminalMode {
    SHELL = 'SHELL',
    CLAUDE = 'CLAUDE'
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
