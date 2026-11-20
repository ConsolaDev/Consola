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

  // Window identity (main -> one renderer)
  WINDOW_WORKSPACE_CHANGED: 'window:workspace-changed',
  WINDOW_OPEN_SETTINGS: 'window:open-settings',
  WINDOW_SHOW_AUTOMATIONS: 'window:show-automations', // A notification click chose the Automations dashboard
  WINDOW_ACTIVATE_SESSION: 'window:activate-session', // A notification click chose a session

  // Personal automations, one factory.yml per workspace (renderer -> main; main runs them)
  AUTOMATIONS_GET_SNAPSHOT: 'automations:get-snapshot', // A workspace's parsed factory.yml, schedule and runs
  AUTOMATIONS_RUN_NOW: 'automations:run-now', // Fire one of a workspace's automations now
  AUTOMATIONS_APPROVE: 'automations:approve', // Approve a run waiting in confirm mode
  AUTOMATIONS_DISMISS: 'automations:dismiss', // Dismiss a run waiting in confirm mode
  AUTOMATIONS_OPEN_FILE: 'automations:open-file', // Open a workspace's factory.yml, creating it from a template
  AUTOMATIONS_ADD_ASSIGNED_REVIEWS: 'automations:add-assigned-reviews', // Add review-assigned-prs to a workspace's factory.yml
  AUTOMATIONS_GET_RUN: 'automations:get-run', // One run's full record, for its side panel
  AUTOMATIONS_READ_CONVERSATION: 'automations:read-conversation', // A run's part of its transcript, read from disk
  AUTOMATIONS_STOP: 'automations:stop', // Stop a running run
  AUTOMATIONS_ADD_TEMPLATE: 'automations:add-template', // Add a ready-made automation to a workspace's factory.yml
  AUTOMATIONS_START_AUTHORING: 'automations:start-authoring', // A session that drafts an entry with the person
  AUTOMATIONS_ACKNOWLEDGE: 'automations:acknowledge', // Mark an agent-added automation as seen
  AUTOMATIONS_GET_ENTRY: 'automations:get-entry', // One factory.yml entry exactly as written, for its details
  AUTOMATIONS_LIST_RUNS: 'automations:list-runs', // One page of a workspace's run history, filtered, newest first
  AUTOMATIONS_GET_RUN_DEFINITION: 'automations:get-run-definition', // A steps run's whole definition snapshot
  AUTOMATIONS_GET_STEP_DETAIL: 'automations:get-step-detail', // One step's record, definition, command.json and log tails
  AUTOMATIONS_READ_STEP_LOG: 'automations:read-step-log', // One step log, up to the 1 MB it holds
  AUTOMATIONS_READ_ARTIFACT: 'automations:read-artifact', // One declared artifact of a step's latest attempt
  AUTOMATIONS_READ_STEP_CONVERSATION: 'automations:read-step-conversation', // A step's part of its transcript, read from disk
  AUTOMATIONS_ALLOW: 'automations:allow', // A person lets a poll entry's check command run, at one version
  AUTOMATIONS_LIST_RUN_TARGETS: 'automations:list-run-targets', // The items Run on… offers an automation
  AUTOMATIONS_RETRY: 'automations:retry', // Retry a failed steps run from its failed step

  // Personal automations (main -> every renderer)
  AUTOMATIONS_CHANGED: 'automations:changed', // A workspace's fresh AutomationsSnapshot
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
  /** Environment variable that redirects this CLI's profile directory. */
  configDirEnvVar: string;
  /** Where that CLI keeps its profile when the variable is unset. */
  defaultConfigDir: string;
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
