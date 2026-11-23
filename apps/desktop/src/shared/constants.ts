// IPC Channel names for communication between main and renderer processes

import type { HarnessDriverId } from './types';

export const IPC_CHANNELS = {
  // Terminal lifecycle (renderer -> main)
  SHELL_ATTACH: 'shell:attach',
  SHELL_RESTART: 'shell:restart',
  SHELL_INPUT: 'shell:input',
  SHELL_RESIZE: 'shell:resize',
  SHELL_DATA: 'shell:data',
  SHELL_EXIT: 'shell:exit',
  TERMINAL_CREATE: 'terminal:create', // Start/attach a session terminal
  TERMINAL_INPUT: 'terminal:input', // User input -> PTY
  TERMINAL_PASTE: 'terminal:paste', // Bracketed-paste a block of text
  TERMINAL_RESIZE: 'terminal:resize', // Terminal dimension changes
  TERMINAL_RESTART: 'terminal:restart', // Relaunch claude after it exited
  TERMINAL_DESTROY: 'terminal:destroy', // Tear down a session terminal
  TERMINAL_DETACH: 'terminal:detach', // A view unmounted; stop sending it output
  TERMINAL_STATUS_SNAPSHOT: 'terminal:status-snapshot', // Live status of every terminal

  // Terminal events (main -> renderer)
  TERMINAL_DATA: 'terminal:data', // PTY output -> renderer
  TERMINAL_ACTIVITY: 'terminal:activity', // Busy/idle inferred from output
  TERMINAL_AWAITING_CONFIRMATION: 'terminal:awaiting-confirmation', // Menu on screen
  TERMINAL_EXIT: 'terminal:exit', // A PTY exited
  TERMINAL_STATUS: 'terminal:status', // Derived status: working | ready | needs-attention | exited

  // Harness queries (renderer -> main)
  HARNESS_PROBE: 'harness:probe', // Binary, version and signed-in account
  HARNESS_SESSION_MODEL: 'harness:session-model',
  HARNESS_CAPABILITIES: 'harness:capabilities', // Slash commands, agents and models it offers

  // Workspace state (renderer -> main; main owns the records)
  WORKSPACE_GET_SNAPSHOT: 'workspace:get-snapshot', // Current list + whether an import is due
  WORKSPACE_IMPORT: 'workspace:import', // One-time handoff from localStorage
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_UPDATE: 'workspace:update',
  WORKSPACE_DELETE: 'workspace:delete',
  WORKSPACE_MOVE: 'workspace:move',
  WORKSPACE_CHECKOUT_CONTEXT: 'workspace:checkout-context',
  WORKSPACE_SESSION_CREATE: 'workspace:session-create',
  WORKSPACE_SESSION_UPDATE: 'workspace:session-update',
  WORKSPACE_SESSION_DELETE: 'workspace:session-delete',
  /** Continue a read-only session as a new one with full tools: a fork of its conversation. */
  WORKSPACE_SESSION_FORK: 'workspace:session-fork',
  WORKSPACE_SESSION_SWITCH_PREVIEW: 'workspace:session-switch-preview', // What switching to each harness would do
  WORKSPACE_SESSION_SWITCH_HARNESS: 'workspace:session-switch-harness',
  WORKSPACE_SESSION_REGENERATE_TITLE: 'workspace:session-regenerate-title',
  WORKSPACE_ADD_SCOPE: 'workspace:add-scope',
  WORKSPACE_UPDATE_SCOPE: 'workspace:update-scope',
  WORKSPACE_REMOVE_SCOPE: 'workspace:remove-scope',
  WORKSPACE_SET_PROVIDER_BINDING: 'workspace:set-provider-binding',
  WORKSPACE_SET_ACTIONS: 'workspace:set-actions', // actions + sectionDefaults, one validated write
  WORKSPACE_GROUP_CREATE: 'workspace:group-create',
  WORKSPACE_GROUP_UPDATE: 'workspace:group-update',
  WORKSPACE_GROUP_ARCHIVE: 'workspace:group-archive',
  WORKSPACE_GROUP_RESTORE: 'workspace:group-restore',
  WORKSPACE_LABEL_CREATE: 'workspace:label-create',
  WORKSPACE_LABEL_UPDATE: 'workspace:label-update',
  WORKSPACE_LABEL_DELETE: 'workspace:label-delete',
  WORKSPACE_LABEL_RESTORE: 'workspace:label-restore',
  WORKSPACE_SESSION_LABEL_ASSIGN: 'workspace:session-label-assign',
  WORKSPACE_SESSION_LABEL_UNASSIGN: 'workspace:session-label-unassign',

  // Conductor orchestration (renderer -> main; main scaffolds, groups, launches)
  CONDUCTOR_CREATE: 'conductor:create',

  ATTENTION_SNAPSHOT: 'attention:snapshot', // Every session's record and derived attention, once
  ATTENTION_VIEWING: 'attention:viewing', // renderer -> main: the session this window is showing, or null
  ATTENTION_FOCUSED: 'attention:focused', // renderer -> main: whether this window has focus
  ATTENTION_CHANGED: 'attention:changed', // main -> renderer: derived attention that changed, coalesced
  ATTENTION_SETTLE: 'attention:settle', // renderer -> main: settle a session and its descendants; answers the memento
  ATTENTION_UNSETTLE: 'attention:unsettle', // renderer -> main: bring a session back, holding auto-settle off
  ATTENTION_RESTORE: 'attention:restore', // renderer -> main: undo, from a memento
  ATTENTION_SNOOZE: 'attention:snooze', // renderer -> main: snooze sessions (and their trees) until a time; answers a SnoozeBatchResult
  ATTENTION_WAKE: 'attention:wake', // renderer -> main: the person brings snoozed sessions back; answers a BatchResult
  ATTENTION_SETTLE_MANY: 'attention:settle-many', // renderer -> main: settle several sessions in one write
  ATTENTION_UNSETTLE_MANY: 'attention:unsettle-many', // renderer -> main: bring several settled sessions back in one write
  PREFERENCES_GET: 'preferences:get',
  PREFERENCES_SET_AUTO_SETTLE_DAYS: 'preferences:set-auto-settle-days',
  PREFERENCES_ACKNOWLEDGE_AUTO_SETTLE: 'preferences:acknowledge-auto-settle',
  PREFERENCES_SET_SNOOZE_PRESETS: 'preferences:set-snooze-presets',
  USAGE_LIMITS_SNAPSHOT: 'usage-limits:snapshot', // Which sessions stopped on a usage limit, and which harnesses are limited
  USAGE_LIMITS_CHANGED: 'usage-limits:changed', // main -> renderer: the full usage-limit state, coalesced
  PREFERENCES_SET_SNOOZE_AT_USAGE_LIMIT: 'preferences:set-snooze-at-usage-limit',
  PREFERENCES_CHANGED: 'preferences:changed', // main -> renderer: the full preferences, to every window
  PREFERENCES_SET_WORKTREE_CLEANUP: 'preferences:set-worktree-cleanup',
  PREFERENCES_SET_TERMINAL_LINKS: 'preferences:set-terminal-links',
  WORKTREE_CLEANUP_PREVIEW: 'worktree-cleanup:preview', // renderer -> main: what the rules would remove now, and why the rest stays
  WORKTREE_CLEANUP_RUN: 'worktree-cleanup:run', // renderer -> main: "Clean up now"; answers the report
  WORKTREE_CLEANUP_HISTORY: 'worktree-cleanup:history', // renderer -> main: what was removed and rebuilt, newest first
  WORKTREE_CLEANUP_CHANGED: 'worktree-cleanup:changed', // main -> renderer: the history changed
  WORKTREE_CLEANUP_IS_MANAGED: 'worktree-cleanup:is-managed', // renderer -> main: whether a folder is one of Consola's own worktrees
  WORKTREE_CLEANUP_DELETED: 'worktree-cleanup:deleted', // main -> renderer: how a deleted session's worktree removal ended
  WORKSPACE_SESSION_DELETE_PREVIEW: 'workspace:session-delete-preview', // renderer -> main: what deleting a session does to its worktree

  // Fleet creation (renderer -> main)
  SESSION_FAN_OUT: 'session:fan-out', // N sessions into a fresh group
  SCOPE_LIST_REPOS: 'workspace:scope-list-repos', // A scope's launch targets

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

  // Dialog channels
  DIALOG_SELECT_FOLDERS: 'dialog:select-folders', // Open folder picker (multi-select)
  DIALOG_SELECT_FOLDER: 'dialog:select-folder', // Open folder picker (single select for workspace)

  // File operations
  FILE_READ: 'file:read', // Read file contents
  FILE_LIST_DIRECTORY: 'file:list-directory', // List directory contents

  // Git operations
  GIT_GET_STATUS: 'git:get-status', // Get git status and stats
  GIT_GET_CHECKOUT: 'git:get-checkout', // Main checkout or linked worktree, and its branch
  GIT_GET_BRANCH_FACTS: 'git:get-branch-facts', // Commits to push or pull, and the distance from the base, never fetched
  GIT_GET_DIFF: 'git:get-diff', // Get file diff
  GIT_STAGE_FILE: 'git:stage-file', // Stage a file (git add)
  GIT_UNSTAGE_FILE: 'git:unstage-file', // Unstage a file (git reset HEAD)
  GIT_COMMIT: 'git:commit', // Create a commit
  GIT_GET_STAGED_DIFF: 'git:get-staged-diff', // Get unified diff of all staged files

  // Commit message generation (headless `claude -p`)
  GENERATE_COMMIT_MESSAGE: 'git:generate-commit-message',

  // Provider operations (renderer -> main). Tokens are borrowed inside main
  // at call time and never cross this boundary.
  PROVIDER_PROBE: 'provider:probe', // Is the CLI installed, who is signed in
  PROVIDER_RESOLVE_REPOS: 'provider:resolve-repos', // Which remote repos have a local clone in this workspace
  PROVIDER_LAUNCH_WORK_ITEM: 'provider:launch-work-item', // Resolve -> worktree -> session record; returns the session
  PROVIDER_RUN_ACTION_IN_SESSION: 'provider:run-action-in-session', // An action's prompt into an existing work-item session
  PROVIDER_CLONE_REPO: 'provider:clone-repo', // Clone an un-cloned repo into a chosen directory
  PROVIDER_FIND_BRANCH_PULL_REQUEST: 'provider:find-branch-pull-request', // A checkout's branch's PR, cached per account, repo and branch

  // Inbox (renderer -> main; main owns the cache)
  INBOX_DETAILS: 'inbox:details',
  INBOX_MUTATE: 'inbox:mutate',
  INBOX_GET: 'inbox:get', // Cached snapshot, or null (a refresh is kicked off)
  INBOX_REFRESH: 'inbox:refresh', // Manual refresh; result arrives on the push channel

  // Inbox (main -> every renderer)
  INBOX_CHANGED: 'inbox:changed', // One workspace's InboxSnapshot

  // Window identity (renderer -> main)
  WINDOW_ACTIVATE_WORKSPACE: 'window:activate-workspace', // Claim a workspace, or be told who holds it
  WINDOW_OPEN: 'window:open', // Open another window
  WINDOW_SET_VIEW: 'window:set-view', // Remember what this workspace is showing

  // The machine Consola runs on (renderer -> main)
  APP_GET_COMPUTER_NAME: 'app:get-computer-name', // The name this computer goes by, read once per run

  // "Open in" a session's folder (renderer -> main; main finds the apps and opens)
  OPEN_IN_LIST: 'open-in:list', // The apps on this computer a folder can be opened in, the file manager last
  OPEN_IN_OPEN: 'open-in:open', // Open a folder in one of them; main checks the app and the folder first

  // Window identity (main -> one renderer)
  WINDOW_WORKSPACE_CHANGED: 'window:workspace-changed',
  WINDOW_OPEN_SETTINGS: 'window:open-settings',
  WINDOW_SHOW_AUTOMATIONS: 'window:show-automations', // A notification click chose the Automations dashboard
  WINDOW_ACTIVATE_SESSION: 'window:activate-session', // A notification click chose a session
  WINDOW_QUIT_SHORTCUT: 'window:quit-shortcut', // ⌘Q is down ('down') or let go ('up'): show the hold-to-quit hint

  // Personal automations, one factory.yml per workspace (renderer -> main; main runs them)
  AUTOMATIONS_GET_SNAPSHOT: 'automations:get-snapshot', // A workspace's parsed factory.yml, schedule and runs
  AUTOMATIONS_RUN_NOW: 'automations:run-now', // Fire one of a workspace's automations now
  AUTOMATIONS_APPROVE: 'automations:approve', // Approve a run waiting in confirm mode
  AUTOMATIONS_DISMISS: 'automations:dismiss', // Dismiss a run waiting in confirm mode
  AUTOMATIONS_OPEN_FILE: 'automations:open-file', // Open one of a workspace's factory files; factory.yml is created from a template
  AUTOMATIONS_RECHECK: 'automations:recheck', // Check again: re-read a workspace's factory folder and re-check what applies
  AUTOMATIONS_ADD_ASSIGNED_REVIEWS: 'automations:add-assigned-reviews', // Add review-assigned-prs to a workspace's factory.yml
  AUTOMATIONS_GET_RUN: 'automations:get-run', // One run's full record, for its side panel
  AUTOMATIONS_READ_CONVERSATION: 'automations:read-conversation', // A run's part of its transcript, read from disk
  AUTOMATIONS_STOP: 'automations:stop', // Stop a running run
  AUTOMATIONS_ADD_TEMPLATE: 'automations:add-template', // Add a ready-made automation to a workspace's factory.yml
  AUTOMATIONS_START_AUTHORING: 'automations:start-authoring', // A session that drafts an entry with the person
  AUTOMATIONS_ACKNOWLEDGE: 'automations:acknowledge', // Mark an agent-added automation as seen
  AUTOMATIONS_GET_ENTRY: 'automations:get-entry', // One factory.yml entry exactly as written, for its details
  AUTOMATIONS_GET_ENTRY_AGENTS: 'automations:get-entry-agents', // An entry's agents as the version that runs has them, for the Allow card
  AUTOMATIONS_LIST_RUNS: 'automations:list-runs', // One page of a workspace's run history, filtered, newest first
  AUTOMATIONS_GET_RUN_DEFINITION: 'automations:get-run-definition', // A steps run's whole definition snapshot
  AUTOMATIONS_GET_STEP_DETAIL: 'automations:get-step-detail', // One step's record, definition, command.json and log tails
  AUTOMATIONS_READ_STEP_LOG: 'automations:read-step-log', // One step log, up to the 1 MB it holds
  AUTOMATIONS_READ_ARTIFACT: 'automations:read-artifact', // One declared artifact of a step's latest attempt
  AUTOMATIONS_OPEN_RUN_CHECKOUT: 'automations:open-run-checkout', // A run's own checkout in the file manager, only that (slice 3-B)
  AUTOMATIONS_READ_STEP_CONVERSATION: 'automations:read-step-conversation', // A step's part of its transcript, read from disk
  AUTOMATIONS_ALLOW: 'automations:allow', // A person lets a poll entry's check command run, at one version
  AUTOMATIONS_LIST_RUN_TARGETS: 'automations:list-run-targets', // The items Run on… offers an automation
  AUTOMATIONS_RETRY: 'automations:retry', // Retry a failed steps run from its failed step
  AUTOMATIONS_CHECK_SERVER: 'automations:check-server', // Check server: start a factory server once, on a person's press, and list its tools
  AUTOMATIONS_GET_GATE: 'automations:get-gate', // A waiting or answered gate's question, material and choices
  AUTOMATIONS_ANSWER_GATE: 'automations:answer-gate', // A person's answer to a run's gate

  // Personal automations (main -> every renderer)
  AUTOMATIONS_CHANGED: 'automations:changed', // A workspace's fresh AutomationsSnapshot

  // Secrets (renderer -> main): names, references and words; no member carries a value
  SECRETS_LIST: 'secrets:list', // A workspace's secret names, where each is used and bound; never a value
  SECRETS_BIND: 'secrets:bind', // Bind a name to a keychain item, a 1Password field or a login-environment variable
  SECRETS_UNBIND: 'secrets:unbind', // Remove a name's binding

  // In-app browser (renderer -> main). Every handler checks the tab belongs to the sender's workspace.
  BROWSER_GET: 'browser:get', // One session's BrowserSessionSnapshot, for the first paint
  BROWSER_OPEN: 'browser:open', // Open a tab in a session
  BROWSER_CLOSE: 'browser:close', // Close a tab
  BROWSER_ACTIVATE: 'browser:activate', // Make a tab the visible one
  BROWSER_NAVIGATE: 'browser:navigate', // Send a tab to an address
  BROWSER_RETRY: 'browser:retry', // A shown tab's automatic retry of an unreachable page on this machine: never the person's input
  BROWSER_BACK: 'browser:back',
  BROWSER_FORWARD: 'browser:forward',
  BROWSER_RELOAD: 'browser:reload',
  BROWSER_STOP: 'browser:stop',
  BROWSER_ATTACH: 'browser:attach', // Bind a mounted <webview> to its tab once it attaches
  BROWSER_SET_VISIBLE: 'browser:set-visible', // Which tab the person is looking at, or none
  BROWSER_HARD_RELOAD: 'browser:hard-reload', // Reload a tab ignoring its cache
  BROWSER_FIND: 'browser:find', // Search a tab's page for text
  BROWSER_STOP_FIND: 'browser:stop-find', // Clear a tab's find highlights
  BROWSER_ZOOM: 'browser:zoom', // Step, reset or read a tab's zoom level
  BROWSER_DEVTOOLS: 'browser:devtools', // Open a tab's DevTools in their own window
  BROWSER_HISTORY: 'browser:history', // The sender's workspace's visited pages, newest first
  BROWSER_CERTIFICATE_CONTINUE: 'browser:certificate-continue', // Trust a refused loopback certificate and reload
  BROWSER_AUTH_ANSWER: 'browser:auth-answer', // The credentials (or a cancel) for a sign-in dialog
  BROWSER_CLEAR_DATA: 'browser:clear-data', // Wipe the sender's workspace's browsing data
  BROWSER_CAPTURE: 'browser:capture', // Save a tab's page as a PNG and answer its path
  BROWSER_LOCAL_SERVERS: 'browser:local-servers', // Servers running from a session's folder

  // In-app browser (main -> renderer)
  BROWSER_SNAPSHOT: 'browser:snapshot', // A session's fresh BrowserSessionSnapshot
  BROWSER_SHORTCUT: 'browser:shortcut', // A shortcut pressed while a page had focus
  BROWSER_FOUND: 'browser:found', // A tab's find result: which match, out of how many
  BROWSER_AUTH_REQUEST: 'browser:auth-request', // A page asks for a username and password
  BROWSER_AUTH_CANCELLED: 'browser:auth-cancelled', // A sign-in dialog's request is over; close it
} as const;

export const DEFAULT_DIMENSIONS = {
  cols: 80,
  rows: 24,
};

/**
 * Lines of history a terminal keeps, in the pane and in main's ScreenModel.
 *
 * One number for both because a pane that remounts (a tab or workspace
 * switch) is repainted from the ScreenModel alone: whatever main holds less
 * than the pane is history the person loses by looking away. A long working
 * session in Claude prints a few thousand lines, mostly diffs.
 *
 * Memory grows with the history actually printed, not with this cap: about
 * 1.5 KB a line at 120 columns, so roughly 30 MB for a full buffer, held once
 * in main and once per mounted pane. Repainting a full buffer serializes it on
 * main in about 120 ms.
 */
export const TERMINAL_SCROLLBACK_LINES = 20_000;

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
  /** Environment variable that redirects this CLI's profile directory, when supported. */
  configDirEnvVar?: string;
  /** Where that CLI keeps its profile when the variable is unset. */
  defaultConfigDir: string;
  /** Example launch arguments shown as the extra-args placeholder. */
  launchArgsPlaceholder: string;
  /**
   * Whether this CLI can describe its own commands, agents and models.
   *
   * Declared here so a driver that cannot answer is not waited on: the
   * composer must not sit on a probe that will never succeed. Must match
   * whether the driver implements `probeCapabilities`.
   */
  supportsCapabilities: boolean;
  /**
   * Model this CLI uses to write session titles when the workspace follows
   * its default harness. Absent means the CLI cannot write titles.
   */
  defaultTitleModel?: string;
  /** Whether this CLI's transcripts can be read back (title regeneration). */
  supportsConversationReading: boolean;
}> = [
  {
    id: 'claude',
    label: 'Claude Code',
    description: "Anthropic's Claude Code CLI.",
    available: true,
    binaryName: 'claude',
    configDirEnvVar: 'CLAUDE_CONFIG_DIR',
    defaultConfigDir: '~/.claude',
    launchArgsPlaceholder: 'e.g. --permission-mode plan',
    supportsCapabilities: true,
    defaultTitleModel: 'haiku',
    supportsConversationReading: true,
  },
  {
    id: 'codex',
    label: 'Codex',
    description: "OpenAI's Codex CLI.",
    available: true,
    binaryName: 'codex',
    configDirEnvVar: 'CODEX_HOME',
    defaultConfigDir: '~/.codex',
    launchArgsPlaceholder: 'e.g. --sandbox read-only',
    supportsCapabilities: true,
    supportsConversationReading: true,
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    description: "Google's Antigravity CLI.",
    available: true,
    binaryName: 'agy',
    defaultConfigDir: '~/.gemini/antigravity-cli',
    launchArgsPlaceholder: 'e.g. --mode plan',
    supportsCapabilities: true,
    supportsConversationReading: true,
  },
];

/** Descriptor for a driver, falling back to the first when id is unknown. */
export function getDriverDescriptor(id: HarnessDriverId | undefined) {
  return HARNESS_DRIVERS.find((driver) => driver.id === id) ?? HARNESS_DRIVERS[0];
}

/** Whether a driver can describe its own commands, agents and models. */
export function driverSupportsCapabilities(id: HarnessDriverId | undefined): boolean {
  if (!id) return true; // Built-in harness runs the Claude driver.
  return HARNESS_DRIVERS.find((driver) => driver.id === id)?.supportsCapabilities ?? false;
}

/** The model a driver writes session titles with, if it can write them. */
export function driverDefaultTitleModel(id: HarnessDriverId | undefined): string | undefined {
  if (!id) return HARNESS_DRIVERS[0].defaultTitleModel; // Built-in harness runs the Claude driver.
  return HARNESS_DRIVERS.find((driver) => driver.id === id)?.defaultTitleModel;
}

/** Whether a driver can read its own conversations back. */
export function driverReadsConversations(id: HarnessDriverId | undefined): boolean {
  if (!id) return true; // Built-in harness runs the Claude driver.
  return HARNESS_DRIVERS.find((driver) => driver.id === id)?.supportsConversationReading ?? false;
}
