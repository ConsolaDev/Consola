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

// Claude Agent SDK Types
export interface AgentInitEvent {
    instanceId: string;
    sessionId: string;
    model: string;
    tools: string[];
    mcpServers: { name: string; status: string }[];
}

export interface AgentMessageEvent {
    instanceId: string;
    uuid: string;
    sessionId: string;
    content: unknown;
}

export interface AgentToolEvent {
    instanceId: string;
    toolName: string;
    toolInput: unknown;
    toolResponse?: unknown;
    toolUseId?: string;  // Correlate with tool_use block
}

export interface AgentResultEvent {
    instanceId: string;
    subtype: string;
    sessionId: string;
    result: string | null;
    isError: boolean;
    numTurns: number;
    totalCostUsd: number;
    usage: {
        input_tokens: number | null;
        output_tokens: number | null;
    };
}

export interface AgentStatus {
    isRunning: boolean;
    sessionId: string | null;
    model: string | null;
    permissionMode: string | null;
}

export interface AgentQueryOptions {
    instanceId: string;
    cwd?: string;
    prompt: string;
    allowedTools?: string[];
    maxTurns?: number;
    resume?: string;
    continue?: boolean;
}

export interface ClaudeAgentAPI {
    startQuery: (options: AgentQueryOptions) => void;
    interrupt: (instanceId: string) => void;
    getStatus: (instanceId: string) => Promise<AgentStatus>;
    destroyInstance: (instanceId: string) => void;
    onInit: (callback: (data: AgentInitEvent) => void) => void;
    onAssistantMessage: (callback: (data: AgentMessageEvent) => void) => void;
    onStream: (callback: (data: unknown) => void) => void;
    onToolPending: (callback: (data: AgentToolEvent) => void) => void;
    onToolComplete: (callback: (data: AgentToolEvent) => void) => void;
    onResult: (callback: (data: AgentResultEvent) => void) => void;
    onError: (callback: (data: { instanceId: string; message: string }) => void) => void;
    onStatusChanged: (callback: (data: AgentStatus & { instanceId: string }) => void) => void;
    onNotification: (callback: (data: { instanceId: string; message: string; title?: string }) => void) => void;
    removeListener: (event: string, callback: Function) => void;
}

declare global {
    interface Window {
        terminalAPI: TerminalAPI;
        claudeAgentAPI: ClaudeAgentAPI;
    }
}
