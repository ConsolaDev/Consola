import type { WorkItemMutation } from '../shared/workItemDetails';
import { UPDATE_CHANNELS, type AppUpdateAPI } from '../shared/appUpdates';
import type { AttentionChange, AttentionState } from '../shared/attention';
import type {
  BatchResult,
  Preferences,
  SettleBatchResult,
  SettleMemento,
  SettleResult,
  SnoozeBatchResult,
} from '../shared/preferences';
import type { SnoozePresetSetting, SnoozeWhen } from '../shared/snooze';
import type { UsageLimitsState } from '../shared/usageLimits';
import type {
  CleanupHistoryEntry,
  CleanupPreview,
  CleanupPreviewRequest,
  CleanupReport,
  SessionDeleteOutcome,
  SessionDeletePreview,
  WorktreeCleanupRules,
} from '../shared/worktreeCleanup';
import type { ShellAPI } from '../shared/shell';
import type { BrowserAPI, TerminalLinkRule } from '../shared/browser';
import type { SessionCheckout, CheckoutContext, CheckoutInfo } from '../shared/sessionCheckout';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  TerminalCreateOptions,
  TerminalSnapshot,
  TerminalDataMessage,
  TerminalActivityMessage,
  TerminalAwaitingConfirmationMessage,
  TerminalExitMessage,
  TerminalStatusMessage,
  TerminalStatusSnapshot,
  HarnessLaunchFields,
  HarnessCapabilitiesResult,
  HarnessProbeResult,
  WorkspaceSnapshot,
  WindowContext,
  WorkspaceView,
  QuitShortcutState,
  ActivateWorkspaceResult,
  WorkItemLaunchResult,
  RunActionInSessionResult,
  CloneRepoResult,
  SessionFanOutIntent,
  SessionFanOutResult,
  ScopeRepo,
  ConductorCreateRequest,
  AutomationsRequest,
} from '../shared/types';
import { IPC_CHANNELS } from '../shared/constants';
import type { AutomationsAPI } from '../shared/automations';
import type { InboxSection } from '../shared/inboxSections';
import type { GitProviderId, ProviderProbeResult } from '../shared/providers';
import type { WorkItemAction } from '../shared/workItemActions';
import type { InboxSnapshot, WorkItemLaunchAction, WorkItemRef } from '../shared/workItems';
import type {
  Group,
  DeletedLabel,
  Label,
  NewGroupFields,
  NewLabelFields,
  NewScopeFields,
  NewSessionFields,
  Scope,
  Session,
  SessionUpdates,
  Workspace,
  WorkspaceProvider,
  WorkspaceUpdates,
} from '../shared/workspace';
import type { Harness, HarnessUpdates, NewHarnessFields } from '../shared/harness';
import type { HarnessSwitchPreview, HarnessSwitchResult } from '../shared/harnessSwitch';

// Subscribe to a main->renderer channel, returning an unsubscribe function so
// callers never have to re-register their peers to remove one listener.
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('appUpdateAPI', {
  getState: () => ipcRenderer.invoke(UPDATE_CHANNELS.GET),
  check: () => ipcRenderer.invoke(UPDATE_CHANNELS.CHECK),
  install: () => ipcRenderer.invoke(UPDATE_CHANNELS.INSTALL),
  onChanged: (callback) => subscribe(UPDATE_CHANNELS.CHANGED, callback),
} satisfies AppUpdateAPI);

contextBridge.exposeInMainWorld('shellAPI', {
  attach: (options) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_ATTACH, options),
  restart: (options) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_RESTART, options),
  input: (id, data) => ipcRenderer.send(IPC_CHANNELS.SHELL_INPUT, id, data),
  resize: (id, cols, rows) => ipcRenderer.send(IPC_CHANNELS.SHELL_RESIZE, id, cols, rows),
  onData: (callback) => subscribe(IPC_CHANNELS.SHELL_DATA, callback),
  onExit: (callback) => subscribe(IPC_CHANNELS.SHELL_EXIT, callback),
} satisfies ShellAPI);

contextBridge.exposeInMainWorld('browserAPI', {
  get: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_GET, sessionId),
  open: (sessionId, url) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_OPEN, sessionId, url),
  close: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLOSE, tabId),
  activate: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_ACTIVATE, tabId),
  navigate: (tabId, url) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_NAVIGATE, tabId, url),
  retry: (tabId, url) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_RETRY, tabId, url),
  back: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_BACK, tabId),
  forward: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_FORWARD, tabId),
  reload: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_RELOAD, tabId),
  stop: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_STOP, tabId),
  hardReload: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_HARD_RELOAD, tabId),
  find: (tabId, text, options) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_FIND, tabId, text, options),
  stopFind: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_STOP_FIND, tabId),
  zoom: (tabId, step) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_ZOOM, tabId, step),
  openDevTools: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DEVTOOLS, tabId),
  history: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_HISTORY),
  capture: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CAPTURE, tabId),
  localServers: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_LOCAL_SERVERS, sessionId),
  continueCertificate: (tabId) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CERTIFICATE_CONTINUE, tabId),
  answerAuth: (id, credentials) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_AUTH_ANSWER, id, credentials),
  clearData: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLEAR_DATA),
  attach: (tabId, webContentsId) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_ATTACH, tabId, webContentsId),
  setVisible: (sessionId, tabId) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SET_VISIBLE, sessionId, tabId),
  onSnapshot: (callback) => subscribe(IPC_CHANNELS.BROWSER_SNAPSHOT, callback),
  onShortcut: (callback) => subscribe(IPC_CHANNELS.BROWSER_SHORTCUT, callback),
  onFound: (callback) => subscribe(IPC_CHANNELS.BROWSER_FOUND, callback),
  onAuthRequest: (callback) => subscribe(IPC_CHANNELS.BROWSER_AUTH_REQUEST, callback),
  onAuthCancelled: (callback) => subscribe(IPC_CHANNELS.BROWSER_AUTH_CANCELLED, callback),
} satisfies BrowserAPI);

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('terminalAPI', {
  // Start or attach to a session's terminal
  create: (options: TerminalCreateOptions): Promise<TerminalSnapshot> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, options);
  },

  // Send user input to the PTY
  sendInput: (instanceId: string, data: string): void => {
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_INPUT, instanceId, data);
  },

  // Paste a block of text as a single unit
  paste: (instanceId: string, text: string): void => {
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_PASTE, instanceId, text);
  },

  // Resize the terminal
  resize: (instanceId: string, cols: number, rows: number): void => {
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_RESIZE, instanceId, cols, rows);
  },

  // Relaunch claude after it exited
  restart: (instanceId: string): void => {
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_RESTART, instanceId);
  },

  // The view unmounted; the terminal keeps running
  detach: (instanceId: string): void => {
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_DETACH, instanceId);
  },

  // Tear down a session's terminal
  destroy: (instanceId: string): void => {
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_DESTROY, instanceId);
  },

  // Live status of every terminal, for a window that missed the edges
  getStatusSnapshot: (): Promise<TerminalStatusSnapshot> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_STATUS_SNAPSHOT);
  },

  onData: (callback: (message: TerminalDataMessage) => void) =>
    subscribe(IPC_CHANNELS.TERMINAL_DATA, callback),

  onActivity: (callback: (message: TerminalActivityMessage) => void) =>
    subscribe(IPC_CHANNELS.TERMINAL_ACTIVITY, callback),

  onAwaitingConfirmation: (callback: (message: TerminalAwaitingConfirmationMessage) => void) =>
    subscribe(IPC_CHANNELS.TERMINAL_AWAITING_CONFIRMATION, callback),

  onExit: (callback: (message: TerminalExitMessage) => void) =>
    subscribe(IPC_CHANNELS.TERMINAL_EXIT, callback),

  onStatus: (callback: (message: TerminalStatusMessage) => void) =>
    subscribe(IPC_CHANNELS.TERMINAL_STATUS, callback),

  // Drag-and-drop's one main-world question. `webUtils` is preload-only, and
  // a `File` cannot cross the context bridge as a value -- the lookup has to
  // happen here, against the object the renderer hands in.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
});

// Expose harness queries to the renderer
contextBridge.exposeInMainWorld('harnessAPI', {
  getSessionModel: (sessionId: string, fields: HarnessLaunchFields): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.HARNESS_SESSION_MODEL, sessionId, fields),

  probe: (fields: HarnessLaunchFields): Promise<HarnessProbeResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HARNESS_PROBE, fields);
  },

  getCapabilities: (fields: HarnessLaunchFields): Promise<HarnessCapabilitiesResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HARNESS_CAPABILITIES, fields);
  },
});

// The Inbox: main owns the cache; the renderer sends intents and listens for
// pushes. Remote actions are explicit and validated in main.
contextBridge.exposeInMainWorld('inboxAPI', {
  getDetails: (workspaceId: string, ref: WorkItemRef) =>
    ipcRenderer.invoke(IPC_CHANNELS.INBOX_DETAILS, workspaceId, ref),
  mutateItem: (workspaceId: string, ref: WorkItemRef, mutation: WorkItemMutation) =>
    ipcRenderer.invoke(IPC_CHANNELS.INBOX_MUTATE, workspaceId, ref, mutation),
  getInbox: (workspaceId: string): Promise<InboxSnapshot | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.INBOX_GET, workspaceId),

  refreshInbox: (workspaceId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.INBOX_REFRESH, workspaceId),

  onInboxChanged: (callback: (snapshot: InboxSnapshot) => void) =>
    subscribe<InboxSnapshot>(IPC_CHANNELS.INBOX_CHANGED, callback),
});

// Provider operations. Tokens never cross this bridge — they are borrowed
// and consumed entirely inside the main process.
contextBridge.exposeInMainWorld('providerAPI', {
  probe: (id: GitProviderId): Promise<ProviderProbeResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_PROBE, id),

  resolveRepos: (workspaceId: string, repos: string[]): Promise<Record<string, string | null>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_RESOLVE_REPOS, workspaceId, repos),

  launchWorkItem: (
    workspaceId: string,
    ref: WorkItemRef,
    action: WorkItemLaunchAction,
  ): Promise<WorkItemLaunchResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_LAUNCH_WORK_ITEM, workspaceId, ref, action),

  runActionInSession: (
    workspaceId: string,
    sessionId: string,
    actionId: string,
  ): Promise<RunActionInSessionResult> =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PROVIDER_RUN_ACTION_IN_SESSION,
      workspaceId,
      sessionId,
      actionId,
    ),

  cloneRepo: (
    workspaceId: string,
    repo: string,
    destinationDir: string,
  ): Promise<CloneRepoResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_CLONE_REPO, workspaceId, repo, destinationDir),
});

// Expose workspace state to the renderer. Main owns the records; the renderer
// sends intents and listens for the result.
contextBridge.exposeInMainWorld('workspaceAPI', {
  getSnapshot: (): Promise<WorkspaceSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_SNAPSHOT),

  importState: (workspaces: Workspace[], version: number): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_IMPORT, workspaces, version),

  createWorkspace: (
    name: string,
    path: string,
    isGitRepo: boolean,
    defaultHarnessId?: string,
  ): Promise<Workspace> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, name, path, isGitRepo, defaultHarnessId),

  updateWorkspace: (id: string, updates: WorkspaceUpdates): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE, id, updates),

  deleteWorkspace: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DELETE, id),

  moveWorkspace: (id: string, beforeId: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_MOVE, id, beforeId),

  checkoutContext: (workspaceId: string, scopeId: string): Promise<CheckoutContext> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CHECKOUT_CONTEXT, workspaceId, scopeId),

  createSession: (
    workspaceId: string,
    fields: NewSessionFields,
    checkout?: SessionCheckout,
  ): Promise<Session | undefined> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SESSION_CREATE, workspaceId, fields, checkout),

  updateSession: (workspaceId: string, sessionId: string, updates: SessionUpdates): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SESSION_UPDATE, workspaceId, sessionId, updates),

  previewSessionDelete: (workspaceId: string, sessionId: string): Promise<SessionDeletePreview> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SESSION_DELETE_PREVIEW, workspaceId, sessionId),
  deleteSession: (
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionDeleteOutcome | undefined> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SESSION_DELETE, workspaceId, sessionId),

  forkSession: (workspaceId: string, sessionId: string): Promise<Session> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SESSION_FORK, workspaceId, sessionId),

  previewHarnessSwitch: (workspaceId: string, sessionId: string): Promise<HarnessSwitchPreview[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SESSION_SWITCH_PREVIEW, workspaceId, sessionId),

  switchHarness: (
    workspaceId: string,
    sessionId: string,
    harnessId: string,
  ): Promise<HarnessSwitchResult> =>
    ipcRenderer.invoke(
      IPC_CHANNELS.WORKSPACE_SESSION_SWITCH_HARNESS,
      workspaceId,
      sessionId,
      harnessId,
    ),

  regenerateSessionTitle: (workspaceId: string, sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SESSION_REGENERATE_TITLE, workspaceId, sessionId),

  addScope: (workspaceId: string, fields: NewScopeFields): Promise<Scope> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ADD_SCOPE, workspaceId, fields),

  updateScope: (
    workspaceId: string,
    scopeId: string,
    updates: Partial<Pick<Scope, 'name' | 'path'>>,
  ): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE_SCOPE, workspaceId, scopeId, updates),

  removeScope: (workspaceId: string, scopeId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE_SCOPE, workspaceId, scopeId),

  setProviderBinding: (workspaceId: string, binding: WorkspaceProvider | null): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SET_PROVIDER_BINDING, workspaceId, binding),

  setActions: (
    workspaceId: string,
    actions: WorkItemAction[],
    sectionDefaults: Partial<Record<InboxSection, string>>,
  ): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SET_ACTIONS, workspaceId, actions, sectionDefaults),

  createGroup: (workspaceId: string, fields: NewGroupFields): Promise<Group> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GROUP_CREATE, workspaceId, fields),

  updateGroup: (
    workspaceId: string,
    groupId: string,
    updates: Partial<Pick<Group, 'name' | 'emoji'>>,
  ): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GROUP_UPDATE, workspaceId, groupId, updates),

  archiveGroup: (workspaceId: string, groupId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GROUP_ARCHIVE, workspaceId, groupId),

  restoreGroup: (workspaceId: string, groupId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GROUP_RESTORE, workspaceId, groupId),

  createLabel: (workspaceId: string, fields: NewLabelFields): Promise<Label> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LABEL_CREATE, workspaceId, fields),

  updateLabel: (
    workspaceId: string,
    labelId: string,
    updates: Partial<Pick<Label, 'name' | 'emoji' | 'color'>>,
  ): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LABEL_UPDATE, workspaceId, labelId, updates),

  deleteLabel: (workspaceId: string, labelId: string): Promise<DeletedLabel | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LABEL_DELETE, workspaceId, labelId),

  restoreLabel: (workspaceId: string, removed: DeletedLabel): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LABEL_RESTORE, workspaceId, removed),

  assignLabel: (workspaceId: string, sessionId: string, labelId: string): Promise<void> =>
    ipcRenderer.invoke(
      IPC_CHANNELS.WORKSPACE_SESSION_LABEL_ASSIGN,
      workspaceId,
      sessionId,
      labelId,
    ),

  unassignLabel: (workspaceId: string, sessionId: string, labelId: string): Promise<void> =>
    ipcRenderer.invoke(
      IPC_CHANNELS.WORKSPACE_SESSION_LABEL_UNASSIGN,
      workspaceId,
      sessionId,
      labelId,
    ),

  fanOut: (intent: SessionFanOutIntent): Promise<SessionFanOutResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_FAN_OUT, intent),

  listScopeRepos: (workspaceId: string, scopeId: string): Promise<ScopeRepo[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCOPE_LIST_REPOS, workspaceId, scopeId),

  onChanged: (callback: (workspaces: Workspace[]) => void) =>
    subscribe<Workspace[]>(IPC_CHANNELS.WORKSPACE_CHANGED, callback),
});

// Conductor orchestration: one intent. The conductor itself is an ordinary
// session and rides the terminal and workspace APIs above.
contextBridge.exposeInMainWorld('conductorAPI', {
  create: (request: ConductorCreateRequest): Promise<Group> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONDUCTOR_CREATE, request),
});

// Expose harness state to the renderer. Main owns the records; the renderer
// sends intents and listens for the result. Separate from `harnessAPI`, which
// probes health: a probe result is a live fact and is never persisted.
contextBridge.exposeInMainWorld('harnessStateAPI', {
  getSnapshot: (): Promise<{ harnesses: Harness[]; needsImport: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.HARNESS_GET_SNAPSHOT),

  importState: (harnesses: Harness[]): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.HARNESS_IMPORT, harnesses),

  addHarness: (input: NewHarnessFields): Promise<Harness> =>
    ipcRenderer.invoke(IPC_CHANNELS.HARNESS_ADD, input),

  updateHarness: (id: string, updates: HarnessUpdates): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.HARNESS_UPDATE, id, updates),

  archiveHarness: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.HARNESS_ARCHIVE, id),

  restoreHarness: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.HARNESS_RESTORE, id),

  onChanged: (callback: (harnesses: Harness[]) => void) =>
    subscribe<Harness[]>(IPC_CHANNELS.HARNESS_CHANGED, callback),
});

// Expose Dialog API to renderer
contextBridge.exposeInMainWorld('dialogAPI', {
  selectFolders: (): Promise<Array<{ path: string; name: string; isGitRepo: boolean }>> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FOLDERS);
  },
  selectFolder: (): Promise<{ path: string; name: string; isGitRepo: boolean } | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FOLDER);
  },
});

// Expose File API to renderer
contextBridge.exposeInMainWorld('fileAPI', {
  readFile: (filePath: string): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, filePath);
  },
  listDirectory: (
    dirPath: string,
  ): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> => {
    return ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST_DIRECTORY, dirPath);
  },
});

// Git status result types
interface GitStatusResult {
  files: Array<{ path: string; status: 'staged' | 'modified' | 'untracked' | 'deleted' }>;
  stats: { modifiedCount: number; addedLines: number; removedLines: number };
  isGitRepo: boolean;
}

// Git diff result types
interface GitDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{
    type: 'context' | 'add' | 'remove';
    content: string;
    oldLineNumber?: number;
    newLineNumber?: number;
  }>;
}

interface GitDiffResult {
  filePath: string;
  staged: boolean;
  oldContent: string;
  newContent: string;
  hunks: GitDiffHunk[];
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
}

// Expose Attention API to renderer
contextBridge.exposeInMainWorld('attentionAPI', {
  getSnapshot: (): Promise<AttentionState> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ATTENTION_SNAPSHOT);
  },
  onChanged: (callback: (change: AttentionChange) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, change: AttentionChange) =>
      callback(change);
    ipcRenderer.on(IPC_CHANNELS.ATTENTION_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ATTENTION_CHANGED, listener);
  },
  setViewing: (instanceId: string | null): void => {
    ipcRenderer.send(IPC_CHANNELS.ATTENTION_VIEWING, instanceId);
  },
  setFocused: (focused: boolean): void => {
    ipcRenderer.send(IPC_CHANNELS.ATTENTION_FOCUSED, focused);
  },
  settle: (workspaceId: string, sessionId: string): Promise<SettleResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ATTENTION_SETTLE, workspaceId, sessionId);
  },
  unsettle: (workspaceId: string, sessionId: string): Promise<SettleMemento> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ATTENTION_UNSETTLE, workspaceId, sessionId);
  },
  restore: (memento: SettleMemento): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ATTENTION_RESTORE, memento);
  },
  snooze: (
    workspaceId: string,
    sessionIds: string[],
    when: SnoozeWhen,
  ): Promise<SnoozeBatchResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ATTENTION_SNOOZE, workspaceId, sessionIds, when);
  },
  wake: (workspaceId: string, sessionIds: string[]): Promise<BatchResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ATTENTION_WAKE, workspaceId, sessionIds);
  },
  settleMany: (workspaceId: string, sessionIds: string[]): Promise<SettleBatchResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ATTENTION_SETTLE_MANY, workspaceId, sessionIds);
  },
  unsettleMany: (workspaceId: string, sessionIds: string[]): Promise<BatchResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ATTENTION_UNSETTLE_MANY, workspaceId, sessionIds);
  },
});

contextBridge.exposeInMainWorld('usageLimitsAPI', {
  getSnapshot: (): Promise<UsageLimitsState> =>
    ipcRenderer.invoke(IPC_CHANNELS.USAGE_LIMITS_SNAPSHOT),
  onChanged: (callback: (state: UsageLimitsState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UsageLimitsState) =>
      callback(state);
    ipcRenderer.on(IPC_CHANNELS.USAGE_LIMITS_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.USAGE_LIMITS_CHANGED, listener);
  },
});

contextBridge.exposeInMainWorld('worktreeCleanupAPI', {
  preview: (request: CleanupPreviewRequest): Promise<CleanupPreview> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_CLEANUP_PREVIEW, request),
  run: (workspaceId?: string): Promise<CleanupReport> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_CLEANUP_RUN, workspaceId),
  history: (workspaceId?: string): Promise<CleanupHistoryEntry[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_CLEANUP_HISTORY, workspaceId),
  isManaged: (dir: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_CLEANUP_IS_MANAGED, dir),
  onDeleted: (callback: (outcome: SessionDeleteOutcome) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, outcome: SessionDeleteOutcome) =>
      callback(outcome);
    ipcRenderer.on(IPC_CHANNELS.WORKTREE_CLEANUP_DELETED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WORKTREE_CLEANUP_DELETED, listener);
  },
  onChanged: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.WORKTREE_CLEANUP_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WORKTREE_CLEANUP_CHANGED, listener);
  },
});

contextBridge.exposeInMainWorld('preferencesAPI', {
  get: (): Promise<Preferences> => ipcRenderer.invoke(IPC_CHANNELS.PREFERENCES_GET),
  setWorktreeCleanup: (rules: WorktreeCleanupRules): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PREFERENCES_SET_WORKTREE_CLEANUP, rules),
  setTerminalLinks: (rule: TerminalLinkRule): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PREFERENCES_SET_TERMINAL_LINKS, rule),
  setAutoSettleDays: (days: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PREFERENCES_SET_AUTO_SETTLE_DAYS, days),
  acknowledgeAutoSettle: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PREFERENCES_ACKNOWLEDGE_AUTO_SETTLE),
  setSnoozePresets: (presets: SnoozePresetSetting[]): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PREFERENCES_SET_SNOOZE_PRESETS, presets),
  setSnoozeAtUsageLimit: (on: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PREFERENCES_SET_SNOOZE_AT_USAGE_LIMIT, on),
  onChanged: (callback: (preferences: Preferences) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, preferences: Preferences) =>
      callback(preferences);
    ipcRenderer.on(IPC_CHANNELS.PREFERENCES_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PREFERENCES_CHANGED, listener);
  },
});

// Expose Git API to renderer
contextBridge.exposeInMainWorld('gitAPI', {
  getStatus: (rootPath: string): Promise<GitStatusResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_GET_STATUS, rootPath);
  },
  getCheckout: (dir: string): Promise<CheckoutInfo> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_GET_CHECKOUT, dir);
  },
  getDiff: (rootPath: string, filePath: string, staged: boolean): Promise<GitDiffResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_GET_DIFF, { rootPath, filePath, staged });
  },
  stageFile: (rootPath: string, filePath: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_STAGE_FILE, { rootPath, filePath });
  },
  unstageFile: (rootPath: string, filePath: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_UNSTAGE_FILE, { rootPath, filePath });
  },
  commit: (rootPath: string, message: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT, { rootPath, message });
  },
  getStagedDiff: (rootPath: string): Promise<{ stagedFiles: string[]; diff: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_GET_STAGED_DIFF, { rootPath });
  },
  generateCommitMessage: (rootPath: string): Promise<{ message: string; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GENERATE_COMMIT_MESSAGE, { rootPath });
  },
});

/**
 * The workspace this window opened on.
 *
 * Passed as a launch argument rather than fetched, so the renderer's very first
 * render already knows what it is looking at.
 */
function readWindowContext(): WindowContext {
  const prefix = '--consola-window=';
  const arg = process.argv.find((value) => value.startsWith(prefix));
  const empty: WindowContext = { workspaceId: null, activeSessionId: null, overlay: null };
  if (!arg) return empty;
  try {
    const context = JSON.parse(arg.slice(prefix.length)) as WindowContext;
    // Main always sends a known overlay; anything else is read as none.
    const overlay =
      context.overlay === 'inbox' || context.overlay === 'automations' ? context.overlay : null;
    const { automationsRunId: runId, automationsName: name, ...rest } = context;
    return {
      ...rest,
      overlay,
      ...(typeof runId === 'string' && runId.length > 0 ? { automationsRunId: runId } : {}),
      ...(typeof name === 'string' && name.length > 0 ? { automationsName: name } : {}),
    };
  } catch {
    return empty;
  }
}

// Personal automations, one file per workspace: main runs them; the renderer
// reads a workspace's snapshot and sends intents.
contextBridge.exposeInMainWorld('automationsAPI', {
  getSnapshot: (workspaceId) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_GET_SNAPSHOT, workspaceId),
  runNow: (workspaceId, name, target) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_RUN_NOW, workspaceId, name, target),
  allow: (workspaceId, name, version) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_ALLOW, workspaceId, name, version),
  listRunTargets: (workspaceId, name) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_LIST_RUN_TARGETS, workspaceId, name),
  approve: (runId) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_APPROVE, runId),
  dismiss: (runId) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_DISMISS, runId),
  openFile: (workspaceId) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_OPEN_FILE, workspaceId),
  addAssignedReviews: (workspaceId) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_ADD_ASSIGNED_REVIEWS, workspaceId),
  getRun: (runId) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_GET_RUN, runId),
  readConversation: (runId) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_READ_CONVERSATION, runId),
  readStepConversation: (runId, stepId) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_READ_STEP_CONVERSATION, runId, stepId),
  listRuns: (workspaceId, query) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_LIST_RUNS, workspaceId, query),
  getRunDefinition: (runId) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_GET_RUN_DEFINITION, runId),
  getStepDetail: (runId, stepId) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_GET_STEP_DETAIL, runId, stepId),
  readStepLog: (runId, stepId, stream) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_READ_STEP_LOG, runId, stepId, stream),
  readArtifact: (runId, ref) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_READ_ARTIFACT, runId, ref),
  retry: (runId, stepId) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_RETRY, runId, stepId),
  stop: (runId) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_STOP, runId),
  addTemplate: (workspaceId, templateId) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_ADD_TEMPLATE, workspaceId, templateId),
  startAuthoring: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_START_AUTHORING, request),
  acknowledge: (workspaceId, name) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_ACKNOWLEDGE, workspaceId, name),
  getEntry: (workspaceId, name) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATIONS_GET_ENTRY, workspaceId, name),
  onChanged: (callback) => subscribe(IPC_CHANNELS.AUTOMATIONS_CHANGED, callback),
} satisfies AutomationsAPI);

contextBridge.exposeInMainWorld('windowAPI', {
  onOpenSettings: (callback: (section?: 'updates') => void) =>
    subscribe<'updates' | undefined>(IPC_CHANNELS.WINDOW_OPEN_SETTINGS, callback),

  onShowAutomations: (callback: (request: AutomationsRequest) => void) =>
    subscribe<AutomationsRequest>(IPC_CHANNELS.WINDOW_SHOW_AUTOMATIONS, callback),

  context: readWindowContext(),

  activateWorkspace: (workspaceId: string | null): Promise<ActivateWorkspaceResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW_ACTIVATE_WORKSPACE, workspaceId),

  openWindow: (workspaceId: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW_OPEN, workspaceId),

  setView: (workspaceId: string | null, view: WorkspaceView): void => {
    ipcRenderer.send(IPC_CHANNELS.WINDOW_SET_VIEW, workspaceId, view);
  },

  onWorkspaceChanged: (callback: (workspaceId: string | null) => void) =>
    subscribe<string | null>(IPC_CHANNELS.WINDOW_WORKSPACE_CHANGED, callback),

  onActivateSession: (callback: (sessionId: string) => void) =>
    subscribe<string>(IPC_CHANNELS.WINDOW_ACTIVATE_SESSION, callback),

  onQuitShortcut: (callback: (state: QuitShortcutState) => void) =>
    subscribe<QuitShortcutState>(IPC_CHANNELS.WINDOW_QUIT_SHORTCUT, callback),
});

// Session storage types
