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
    skills: string[];
    slashCommands: string[];
    plugins: { name: string; path: string }[];
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

// Session lifecycle events
export interface SessionEndEvent {
    instanceId: string;
    reason: 'clear' | 'logout' | 'prompt_input_exit' | 'other';
    sessionId: string;
}

export interface SessionStartEvent {
    instanceId: string;
    source: 'startup' | 'resume' | 'clear' | 'compact';
    sessionId: string;
    model?: string;
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

// Trust mode - session-wide permission policy (like Claude Code's accept all)
export type TrustMode = 'off' | 'session';  // 'off' = ask per action, 'session' = auto-approve all for session

export interface TrustModeSettings {
    mode: TrustMode;
    enabledAt?: number;  // Timestamp when enabled
}

export interface TrustModeChangeRequest {
    instanceId: string;
    mode: TrustMode;
}

export interface TrustModeChangedEvent {
    instanceId: string;
    mode: TrustMode;
    enabledAt?: number;
}

// Media attachment types
export type MediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface MediaAttachment {
    /** Unique identifier for this attachment */
    id: string;
    /** Display name (e.g., "Image 1", "Image 2") */
    displayName: string;
    /** Original filename from the user's filesystem */
    originalFilename: string;
    /** MIME type */
    mediaType: MediaType;
    /** File size in bytes */
    size: number;
    /** Width in pixels (if available) */
    width?: number;
    /** Height in pixels (if available) */
    height?: number;
}

export interface MediaAttachmentResult {
    attachment: MediaAttachment;
    /** Base64-encoded thumbnail for preview (max 200x200) */
    thumbnailBase64: string;
}

export interface MediaAPI {
    addFromPath: (instanceId: string, filePath: string) => Promise<MediaAttachmentResult>;
    remove: (instanceId: string, attachmentId: string) => Promise<void>;
    getBase64: (instanceId: string, attachmentId: string) => Promise<{ data: string; mediaType: MediaType }>;
    cleanupInstance: (instanceId: string) => Promise<void>;
}

export interface AgentQueryOptions {
    instanceId: string;
    cwd?: string;
    additionalDirectories?: string[];
    prompt: string;
    allowedTools?: string[];
    maxTurns?: number;
    resume?: string;
    /** Image attachments to include with the message */
    images?: Array<{ attachmentId: string; displayName: string }>;
}

export interface ClaudeAgentAPI {
    startQuery: (options: AgentQueryOptions) => void;
    interrupt: (instanceId: string) => void;
    getStatus: (instanceId: string) => Promise<AgentStatus>;
    destroyInstance: (instanceId: string) => void;
    respondToInput: (response: AgentInputResponse) => void;
    initialize: (instanceId: string, cwd: string) => Promise<{
        skills: string[];
        slashCommands: string[];
        plugins: { name: string; path: string }[];
    }>;
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
    onSessionEnd: (callback: (data: SessionEndEvent) => void) => void;
    onSessionStart: (callback: (data: SessionStartEvent) => void) => void;
    removeListener: (event: string, callback: Function) => void;
}

declare global {
    interface Window {
        terminalAPI: TerminalAPI;
        claudeCliAPI: ClaudeCliAPI;
        claudeAgentAPI: ClaudeAgentAPI;
    }
}
