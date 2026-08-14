export enum TerminalMode {
    SHELL = 'SHELL',
    CLAUDE = 'CLAUDE'
}

export interface TerminalDimensions {
    cols: number;
    rows: number;
}

export interface TerminalCreateOptions {
    instanceId: string;
    cwd: string;
    /** Session ID Consola assigned to this tab. */
    claudeSessionId: string;
    /** Resume the existing conversation instead of starting one. */
    resume: boolean;
    /** Initial size, so the TUI paints at the right dimensions immediately. */
    cols?: number;
    rows?: number;
    /** Prompt to submit once the CLI is ready for input. */
    initialPrompt?: string;
}

/** State needed to repaint a terminal view on mount. */
export interface TerminalSnapshot {
    replay: string;
    mode: TerminalMode;
    exited: boolean;
}

export interface TerminalDataMessage {
    instanceId: string;
    data: string;
}

export interface TerminalModeChangedMessage {
    instanceId: string;
    mode: TerminalMode;
}

export interface TerminalActivityMessage {
    instanceId: string;
    busy: boolean;
}

export interface TerminalAwaitingConfirmationMessage {
    instanceId: string;
    awaiting: boolean;
}

export interface TerminalExitMessage {
    instanceId: string;
    mode: TerminalMode;
    exitCode: number;
}

export interface TerminalAPI {
    create: (options: TerminalCreateOptions) => Promise<TerminalSnapshot>;
    sendInput: (instanceId: string, data: string) => void;
    paste: (instanceId: string, text: string) => void;
    resize: (instanceId: string, cols: number, rows: number) => void;
    switchMode: (instanceId: string, mode: TerminalMode) => void;
    restart: (instanceId: string) => void;
    destroy: (instanceId: string) => void;
    onData: (callback: (message: TerminalDataMessage) => void) => () => void;
    onModeChanged: (callback: (message: TerminalModeChangedMessage) => void) => () => void;
    onActivity: (callback: (message: TerminalActivityMessage) => void) => () => void;
    onAwaitingConfirmation: (
        callback: (message: TerminalAwaitingConfirmationMessage) => void
    ) => () => void;
    onExit: (callback: (message: TerminalExitMessage) => void) => () => void;
}

export interface ClaudeCliAPI {
    isAvailable: () => Promise<boolean>;
    getSessionName: (claudeSessionId: string) => Promise<string | null>;
}

declare global {
    interface Window {
        terminalAPI: TerminalAPI;
        claudeCliAPI: ClaudeCliAPI;
    }
}
