import type { NewSessionFields, Session, Workspace } from './workspace';
import type { Harness, HarnessUpdates, NewHarnessFields } from './harness';

/** Agent CLI a harness drives. One driver per supported CLI. */
export type HarnessDriverId = 'claude';

/**
 * How a session's harness is described across the IPC boundary.
 *
 * Kept as flat optional fields rather than a nested object: every one of them
 * is absent for the built-in harness, and absent must mean "behave exactly as
 * Consola did before harnesses existed".
 */
export interface HarnessLaunchFields {
    /** Driver backing this session. Defaults to `claude`. */
    driverId?: HarnessDriverId;
    /** Explicit binary path, when the harness pins one. */
    binaryOverride?: string;
    /** Config directory for the driver's own env var, when the harness sets one. */
    configDirOverride?: string;
    /** Extra CLI arguments appended to the session's argv. */
    extraArgs?: string[];
}

export interface TerminalDimensions {
    cols: number;
    rows: number;
}

export interface TerminalCreateOptions extends HarnessLaunchFields {
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
    exited: boolean;
}

/**
 * What a renderer gets when it asks main for the workspace list.
 *
 * `needsImport` is true only on the first launch after workspaces moved into
 * the main process, when the records still live in the renderer's localStorage.
 */
export interface WorkspaceSnapshot {
    workspaces: Workspace[];
    needsImport: boolean;
}

export interface TerminalDataMessage {
    instanceId: string;
    data: string;
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
    exitCode: number;
}

export interface TerminalAPI {
    create: (options: TerminalCreateOptions) => Promise<TerminalSnapshot>;
    sendInput: (instanceId: string, data: string) => void;
    paste: (instanceId: string, text: string) => void;
    resize: (instanceId: string, cols: number, rows: number) => void;
    restart: (instanceId: string) => void;
    destroy: (instanceId: string) => void;
    onData: (callback: (message: TerminalDataMessage) => void) => () => void;
    onActivity: (callback: (message: TerminalActivityMessage) => void) => () => void;
    onAwaitingConfirmation: (
        callback: (message: TerminalAwaitingConfirmationMessage) => void
    ) => () => void;
    onExit: (callback: (message: TerminalExitMessage) => void) => () => void;
}

/**
 * Who a harness is signed in as, read from the driver's own config directory.
 *
 * Consola stores no credentials of its own: a harness points at a config
 * directory and the CLI that owns it decides what is in there.
 */
export interface HarnessAccount {
    emailAddress?: string;
    displayName?: string;
    organizationName?: string;
    /** Raw plan identifier, e.g. `claude_max`. */
    organizationType?: string;
}

export interface HarnessProbeResult {
    /** The binary was found and is executable. */
    available: boolean;
    /** Path actually resolved, useful when the harness relies on PATH. */
    resolvedBinary: string;
    /** Version string as reported by the CLI. */
    version?: string;
    /** Absent when the config directory holds no signed-in account. */
    account?: HarnessAccount;
    error?: string;
}

export interface HarnessAPI {
    probe: (fields: HarnessLaunchFields) => Promise<HarnessProbeResult>;
    getSessionName: (
        sessionId: string,
        fields: HarnessLaunchFields
    ) => Promise<string | null>;
}

/**
 * Workspace state exposed to the renderer. Main owns the records; the
 * renderer sends intents and listens for the result.
 */
export interface WorkspaceAPI {
    getSnapshot: () => Promise<WorkspaceSnapshot>;
    importState: (workspaces: Workspace[], version: number) => Promise<boolean>;
    createWorkspace: (
        name: string,
        path: string,
        isGitRepo: boolean,
        defaultHarnessId?: string
    ) => Promise<Workspace>;
    updateWorkspace: (
        id: string,
        updates: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>>
    ) => Promise<void>;
    deleteWorkspace: (id: string) => Promise<void>;
    createSession: (workspaceId: string, fields: NewSessionFields) => Promise<Session | undefined>;
    updateSession: (
        workspaceId: string,
        sessionId: string,
        updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>
    ) => Promise<void>;
    deleteSession: (workspaceId: string, sessionId: string) => Promise<void>;
    onChanged: (callback: (workspaces: Workspace[]) => void) => () => void;
}

/**
 * Harness state exposed to the renderer. Main owns the records; the renderer
 * sends intents and listens for the result. Separate from `HarnessAPI`, which
 * probes health: a probe result is a live fact and is never persisted.
 */
export interface HarnessStateAPI {
    getSnapshot: () => Promise<{ harnesses: Harness[]; needsImport: boolean }>;
    importState: (harnesses: Harness[]) => Promise<boolean>;
    addHarness: (input: NewHarnessFields) => Promise<Harness>;
    updateHarness: (id: string, updates: HarnessUpdates) => Promise<void>;
    archiveHarness: (id: string) => Promise<void>;
    restoreHarness: (id: string) => Promise<void>;
    onChanged: (callback: (harnesses: Harness[]) => void) => () => void;
}

declare global {
    interface Window {
        terminalAPI: TerminalAPI;
        harnessAPI: HarnessAPI;
        workspaceAPI: WorkspaceAPI;
        harnessStateAPI: HarnessStateAPI;
        windowAPI: WindowAPI;
    }
}

/**
 * What a window is looking at.
 *
 * Injected at construction through `additionalArguments`, so the first paint
 * already knows its workspace and no frame is spent on an empty shell. Changes
 * afterwards arrive on WINDOW_WORKSPACE_CHANGED.
 */
export interface WindowContext {
    workspaceId: string | null;
    activeSessionId: string | null;
}

/** Verdict from asking main to point this window at a workspace. */
export type ActivateWorkspaceResult = 'took' | 'focused-elsewhere';

/**
 * This window's identity, exposed by preload. Main arbitrates every change:
 * a workspace lives in at most one window, so `activateWorkspace` reports a
 * verdict rather than just applying the request.
 */
export interface WindowAPI {
    context: WindowContext;
    activateWorkspace: (workspaceId: string | null) => Promise<ActivateWorkspaceResult>;
    openWindow: (workspaceId: string | null) => Promise<void>;
    setActiveSession: (sessionId: string | null) => void;
    onWorkspaceChanged: (callback: (workspaceId: string | null) => void) => () => void;
}
