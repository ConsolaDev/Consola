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
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;
  maxOutputTokens: number;
  costUSD: number;
}

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
    modelUsage?: Record<string, ModelUsage>;
}

export interface AgentStatus {
    isRunning: boolean;
    sessionId: string | null;
    model: string | null;
    permissionMode: string | null;
}

// Permission/Approval request from SDK
export interface AgentInputRequest {
    instanceId: string;
    requestId: string;
    type: 'permission' | 'question';
    toolName?: string;
    toolInput?: Record<string, unknown>;
    description?: string;
    suggestions?: PermissionSuggestion[];
    // For question type (AskUserQuestion tool)
    questions?: AgentQuestion[];
}

export interface AgentQuestion {
    question: string;
    header: string;
    options: AgentQuestionOption[];
    multiSelect?: boolean;
}

export interface AgentQuestionOption {
    label: string;
    description?: string;
}

export interface PermissionSuggestion {
    label: string;
    action: 'allow_once' | 'allow_always' | 'deny';
}

// Response to permission request
export interface AgentInputResponse {
    instanceId: string;
    requestId: string;
    action: 'approve' | 'reject' | 'modify';
    modifiedInput?: Record<string, unknown>;
    feedback?: string;
    answers?: Record<string, string>;  // For question responses
}

export interface AgentQueryOptions {
    instanceId: string;
    cwd?: string;
    additionalDirectories?: string[];
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
    respondToInput: (response: AgentInputResponse) => void;
    onInit: (callback: (data: AgentInitEvent) => void) => void;
    onAssistantMessage: (callback: (data: AgentMessageEvent) => void) => void;
    onStream: (callback: (data: unknown) => void) => void;
    onToolPending: (callback: (data: AgentToolEvent) => void) => void;
    onToolComplete: (callback: (data: AgentToolEvent) => void) => void;
    onResult: (callback: (data: AgentResultEvent) => void) => void;
    onError: (callback: (data: { instanceId: string; message: string }) => void) => void;
    onStatusChanged: (callback: (data: AgentStatus & { instanceId: string }) => void) => void;
    onNotification: (callback: (data: { instanceId: string; message: string; title?: string }) => void) => void;
    onInputRequest: (callback: (data: AgentInputRequest) => void) => void;
    removeListener: (event: string, callback: Function) => void;
}

declare global {
    interface Window {
        terminalAPI: TerminalAPI;
        claudeAgentAPI: ClaudeAgentAPI;
    }
}
