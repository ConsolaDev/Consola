// IPC Channel names for communication between main and renderer processes

import type { HarnessDriverId } from './types';

export const IPC_CHANNELS = {
    // Terminal lifecycle (renderer -> main)
    TERMINAL_CREATE: 'terminal:create',       // Start/attach a session terminal
    TERMINAL_INPUT: 'terminal:input',         // User input -> PTY
    TERMINAL_PASTE: 'terminal:paste',         // Bracketed-paste a block of text
    TERMINAL_RESIZE: 'terminal:resize',       // Terminal dimension changes
    TERMINAL_RESTART: 'terminal:restart',     // Relaunch claude after it exited
    TERMINAL_DESTROY: 'terminal:destroy',     // Tear down a session terminal
    TERMINAL_STATUS_SNAPSHOT: 'terminal:status-snapshot', // Live status of every terminal

    // Terminal events (main -> renderer)
    TERMINAL_DATA: 'terminal:data',           // PTY output -> renderer
    TERMINAL_ACTIVITY: 'terminal:activity',   // Busy/idle inferred from output
    TERMINAL_AWAITING_CONFIRMATION: 'terminal:awaiting-confirmation', // Menu on screen
    TERMINAL_EXIT: 'terminal:exit',           // A PTY exited

    // Harness queries (renderer -> main)
    HARNESS_PROBE: 'harness:probe',               // Binary, version and signed-in account
    HARNESS_SESSION_NAME: 'harness:session-name', // Name from the driver's own transcripts
    HARNESS_CAPABILITIES: 'harness:capabilities', // Slash commands, agents and models it offers

    // Workspace state (renderer -> main; main owns the records)
    WORKSPACE_GET_SNAPSHOT: 'workspace:get-snapshot',   // Current list + whether an import is due
    WORKSPACE_IMPORT: 'workspace:import',               // One-time handoff from localStorage
    WORKSPACE_CREATE: 'workspace:create',
    WORKSPACE_UPDATE: 'workspace:update',
    WORKSPACE_DELETE: 'workspace:delete',
    WORKSPACE_SESSION_CREATE: 'workspace:session-create',
    WORKSPACE_SESSION_UPDATE: 'workspace:session-update',
    WORKSPACE_SESSION_DELETE: 'workspace:session-delete',
    WORKSPACE_ADD_SCOPE: 'workspace:add-scope',
    WORKSPACE_REMOVE_SCOPE: 'workspace:remove-scope',
    WORKSPACE_SET_GITHUB_BINDING: 'workspace:set-github-binding',
    WORKSPACE_GROUP_CREATE: 'workspace:group-create',
    WORKSPACE_GROUP_ARCHIVE: 'workspace:group-archive',

    // Workspace state (main -> every renderer)
    WORKSPACE_CHANGED: 'workspace:changed',

    // Harness records (renderer -> main). Health probes stay on harness:probe.
    HARNESS_GET_SNAPSHOT: 'harness:get-snapshot',
    HARNESS_IMPORT: 'harness:import',
    HARNESS_ADD: 'harness:add',
    HARNESS_UPDATE: 'harness:update',
    HARNESS_ARCHIVE: 'harness:archive',
    HARNESS_RESTORE: 'harness:restore',

    // Harness records (main -> every renderer)
    HARNESS_CHANGED: 'harness:changed',

    // GitHub via the gh CLI (renderer -> main). Probes only: tokens are
    // borrowed inside main at spawn/call time and never cross this boundary.
    GH_PROBE: 'github:probe',

    // Dialog channels
    DIALOG_SELECT_FOLDERS: 'dialog:select-folders',  // Open folder picker (multi-select)
    DIALOG_SELECT_FOLDER: 'dialog:select-folder',    // Open folder picker (single select for workspace)

    // File operations
    FILE_READ: 'file:read',  // Read file contents
    FILE_LIST_DIRECTORY: 'file:list-directory',  // List directory contents

    // Git operations
    GIT_GET_STATUS: 'git:get-status',  // Get git status and stats
    GIT_GET_DIFF: 'git:get-diff',      // Get file diff
    GIT_STAGE_FILE: 'git:stage-file',  // Stage a file (git add)
    GIT_UNSTAGE_FILE: 'git:unstage-file',  // Unstage a file (git reset HEAD)
    GIT_COMMIT: 'git:commit',          // Create a commit
    GIT_GET_STAGED_DIFF: 'git:get-staged-diff',  // Get unified diff of all staged files

    // Commit message generation (headless `claude -p`)
    GENERATE_COMMIT_MESSAGE: 'git:generate-commit-message',

    // GitHub inbox (renderer -> main; main owns the cache)
    GITHUB_GET_INBOX: 'github:get-inbox',           // Cached snapshot, or null (a refresh is kicked off)
    GITHUB_REFRESH_INBOX: 'github:refresh-inbox',   // Manual refresh; result arrives on the push channel
    GITHUB_RESOLVE_REPOS: 'github:resolve-repos',   // Which remote repos have a local clone in this workspace
    GITHUB_LAUNCH_WORK_ITEM: 'github:launch-work-item', // Resolve -> worktree -> session record; returns the session
    GITHUB_CLONE_REPO: 'github:clone-repo',         // Clone an un-cloned repo into a chosen directory

    // GitHub inbox (main -> every renderer)
    GITHUB_INBOX_CHANGED: 'github:inbox-changed',   // One workspace's InboxSnapshot

    // Window identity (renderer -> main)
    WINDOW_ACTIVATE_WORKSPACE: 'window:activate-workspace', // Claim a workspace, or be told who holds it
    WINDOW_OPEN: 'window:open',                             // Open another window
    WINDOW_SET_ACTIVE_SESSION: 'window:set-active-session',  // Remember it for relaunch

    // Window identity (main -> one renderer)
    WINDOW_WORKSPACE_CHANGED: 'window:workspace-changed',
} as const;

export const DEFAULT_DIMENSIONS = {
    cols: 80,
    rows: 24,
};

/** Identifier of the harness every workspace and session falls back to. */
export const BUILT_IN_HARNESS_ID = 'default';

/**
 * Agent CLIs a harness can be built on.
 *
 * Listed here rather than derived from the main process's driver registry so
 * the settings UI can render the choice without an IPC round trip. Entries
 * marked unavailable show as upcoming and cannot be selected.
 */
export const HARNESS_DRIVERS: ReadonlyArray<{
    id: HarnessDriverId;
    label: string;
    description: string;
    available: boolean;
    /** Binary this CLI installs as, shown as the binary-path placeholder. */
    binaryName: string;
    /** Environment variable that redirects this CLI's profile directory. */
    configDirEnvVar: string;
    /** Where that CLI keeps its profile when the variable is unset. */
    defaultConfigDir: string;
    /**
     * Whether this CLI's transcripts can be read to name a session.
     *
     * Declared here so the renderer can skip polling for a name that will
     * never arrive. Must match whether the driver implements
     * `getSessionDisplayName`.
     */
    supportsSessionNaming: boolean;
    /**
     * Whether this CLI can describe its own commands, agents and models.
     *
     * Declared here for the same reason as `supportsSessionNaming`: a driver
     * that cannot answer must not have the composer waiting on a probe that
     * will never succeed. Must match whether the driver implements
     * `probeCapabilities`.
     */
    supportsCapabilities: boolean;
}> = [
    {
        id: 'claude',
        label: 'Claude Code',
        description: "Anthropic's Claude Code CLI.",
        available: true,
        binaryName: 'claude',
        configDirEnvVar: 'CLAUDE_CONFIG_DIR',
        defaultConfigDir: '~/.claude',
        supportsSessionNaming: true,
        supportsCapabilities: true,
    },
];

/** Descriptor for a driver, falling back to the first when id is unknown. */
export function getDriverDescriptor(id: HarnessDriverId | undefined) {
    return HARNESS_DRIVERS.find((driver) => driver.id === id) ?? HARNESS_DRIVERS[0];
}

/** Whether a driver can name sessions from its own transcripts. */
export function driverSupportsSessionNaming(id: HarnessDriverId | undefined): boolean {
    if (!id) return true; // Built-in harness runs the Claude driver.
    return HARNESS_DRIVERS.find((driver) => driver.id === id)?.supportsSessionNaming ?? false;
}

/** Whether a driver can describe its own commands, agents and models. */
export function driverSupportsCapabilities(id: HarnessDriverId | undefined): boolean {
    if (!id) return true; // Built-in harness runs the Claude driver.
    return HARNESS_DRIVERS.find((driver) => driver.id === id)?.supportsCapabilities ?? false;
}
