import type {
    Group,
    NewGroupFields,
    NewScopeFields,
    NewSessionFields,
    Scope,
    Session,
    Workspace,
} from './workspace';
import type { Harness, HarnessUpdates, NewHarnessFields } from './harness';
import type { GhProbeResult, InboxSnapshot, WorkItemRef } from './github';
import type { TerminalStatus } from './terminalStatus';

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
    /**
     * Workspace this session belongs to. Main resolves it to the workspace's
     * GitHub account binding (if any) and borrows GH_TOKEN itself — the
     * renderer names the workspace precisely so it never has to see a token.
     */
    workspaceId: string;
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
    /**
     * Model this session is pinned to, as the CLI's own selector value.
     *
     * Session-scoped rather than part of `HarnessLaunchFields`: a harness
     * describes an installation, while the model is chosen per conversation
     * and then fixed, exactly like `harnessId`.
     */
    model?: string;
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

export interface TerminalStatusMessage {
    instanceId: string;
    status: TerminalStatus;
}

/**
 * Live status of every terminal the main process holds, keyed by instanceId.
 *
 * Shaped to match the renderer's `TerminalState` so a store can adopt an entry
 * without translating it.
 */
export type TerminalStatusSnapshot = Record<
    string,
    {
        isBusy: boolean;
        isAwaitingConfirmation: boolean;
        hasExited: boolean;
    }
>;

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
    onStatus: (callback: (message: TerminalStatusMessage) => void) => () => void;
    getStatusSnapshot: () => Promise<TerminalStatusSnapshot>;
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

/** One slash command a harness offers, as the CLI itself describes it. */
export interface HarnessCommand {
    /** Plugin-qualified, e.g. `feature-dev:feature-dev`. */
    name: string;
    description: string;
    /** Placeholder for arguments the command takes, when it takes any. */
    argumentHint?: string;
    aliases?: string[];
}

/** One subagent a harness can dispatch to. */
export interface HarnessAgent {
    name: string;
    description: string;
}

/** One model a harness offers, already labelled for display by the CLI. */
export interface HarnessModel {
    /** Value to pass back as the model selector, e.g. `sonnet`. */
    value: string;
    /** Concrete model the selector resolves to today. */
    resolvedModel: string;
    displayName: string;
    description: string;
    supportsEffort?: boolean;
    supportedEffortLevels?: string[];
    supportsFastMode?: boolean;
    supportsAdaptiveThinking?: boolean;
    supportsAutoMode?: boolean;
}

/**
 * Who a harness is signed in as, according to the CLI rather than its files.
 *
 * Richer than `HarnessAccount` — it carries a plan name already worded for
 * display — but it costs a full capability probe, so it enhances the account
 * read from disk rather than replacing it.
 */
export interface HarnessCapabilityAccount {
    signedIn: boolean;
    emailAddress?: string;
    organization?: string;
    /** Already human-readable, e.g. `Claude Max`. */
    subscriptionType?: string;
    apiProvider?: string;
}

/**
 * What a harness can offer a composer: its commands, agents and models.
 *
 * Deliberately separate from `HarnessProbeResult`. Health is cheap, always
 * re-run, and every driver can answer it; capabilities cost a subprocess
 * handshake that runs the user's session hooks, are cached for the app's
 * lifetime, and a driver may not be able to answer them at all.
 */
export interface HarnessCapabilities {
    commands: HarnessCommand[];
    agents: HarnessAgent[];
    models: HarnessModel[];
    outputStyles: string[];
    account?: HarnessCapabilityAccount;
}

/** Why a harness could not describe itself. Never a thrown error at the UI. */
export interface HarnessCapabilitiesUnavailable {
    supported: false;
    reason: string;
}

export type HarnessCapabilitiesResult =
    | ({ supported: true } & HarnessCapabilities)
    | HarnessCapabilitiesUnavailable;

/**
 * A session's display name and where it came from. `summary` is the CLI's own
 * settled name for the conversation; `prompt` is a stand-in read from the
 * opening message, so a caller adopting names knows to keep asking until a
 * summary lands.
 */
export interface SessionNameResult {
    name: string;
    source: 'summary' | 'prompt';
}

export interface HarnessAPI {
    probe: (fields: HarnessLaunchFields) => Promise<HarnessProbeResult>;
    getSessionName: (
        sessionId: string,
        fields: HarnessLaunchFields
    ) => Promise<SessionNameResult | null>;
    getCapabilities: (fields: HarnessLaunchFields) => Promise<HarnessCapabilitiesResult>;
}

/**
 * GitHub probing exposed to the renderer.
 *
 * Probe only: whether `gh` exists and which accounts its keyring holds.
 * Tokens are borrowed inside the main process at spawn/call time and have no
 * representation on this API at all.
 */
export interface GitHubAPI {
    probe: () => Promise<GhProbeResult>;
}

/**
 * Outcome of the one-click work-item launch.
 *
 * 'not-cloned' is a normal answer, not an error: the renderer responds by
 * offering the clone-into-scope dialog. 'error' carries the git/gh message and
 * is surfaced on the Inbox item — never a dialog.
 */
export type WorkItemLaunchResult =
    | { ok: true; session: Session; seedPrompt?: string; reattached: boolean }
    | { ok: false; reason: 'not-cloned' }
    | { ok: false; reason: 'error'; message: string };

export interface CloneRepoResult {
    ok: boolean;
    /** Absolute path of the fresh clone when ok. */
    path?: string;
    error?: string;
}

/**
 * Inbox surface of the github preload API. Read-only against GitHub by
 * construction: there is no method here that writes to GitHub.
 */
export interface GitHubInboxAPI {
    getInbox: (workspaceId: string) => Promise<InboxSnapshot | null>;
    refreshInbox: (workspaceId: string) => Promise<void>;
    resolveRepos: (workspaceId: string, repos: string[]) => Promise<Record<string, string | null>>;
    launchWorkItem: (workspaceId: string, workItem: WorkItemRef) => Promise<WorkItemLaunchResult>;
    cloneRepo: (workspaceId: string, repo: string, destinationDir: string) => Promise<CloneRepoResult>;
    onInboxChanged: (callback: (snapshot: InboxSnapshot) => void) => () => void;
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
        updates: Partial<Pick<Session, 'name' | 'nameIsUserSet' | 'lastActiveAt' | 'hasStarted' | 'groupId'>>
    ) => Promise<void>;
    deleteSession: (workspaceId: string, sessionId: string) => Promise<void>;
    addScope: (workspaceId: string, fields: NewScopeFields) => Promise<Scope>;
    /** Rejects while any session still references the scope. */
    removeScope: (workspaceId: string, scopeId: string) => Promise<void>;
    setGitHubBinding: (
        workspaceId: string,
        binding: { accountLogin: string; org?: string } | null
    ) => Promise<void>;
    createGroup: (workspaceId: string, fields: NewGroupFields) => Promise<Group>;
    archiveGroup: (workspaceId: string, groupId: string) => Promise<void>;
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
        githubAPI: GitHubAPI & GitHubInboxAPI;
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
