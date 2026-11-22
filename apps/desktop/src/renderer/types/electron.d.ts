import type {
  CleanupHistoryEntry,
  CleanupPreview,
  CleanupPreviewRequest,
  CleanupReport,
  SessionDeleteOutcome,
  WorktreeCleanupRules,
} from '../../shared/worktreeCleanup';
import type { AppUpdateAPI } from '../../shared/appUpdates';
import type { BrowserAPI, TerminalLinkRule } from '../../shared/browser';
import type { OpenInAPI } from '../../shared/openIn';
import type { AttentionChange, AttentionState } from '../../shared/attention';
import type {
  BatchResult,
  Preferences,
  SettleBatchResult,
  SettleMemento,
  SettleResult,
  SnoozeBatchResult,
} from '../../shared/preferences';
import type { SnoozePresetSetting, SnoozeWhen } from '../../shared/snooze';
import type { UsageLimitsState } from '../../shared/usageLimits';
import type { CheckoutInfo } from '../../shared/sessionCheckout';
import type { BranchFacts } from '../../shared/branchFacts';
export interface FolderInfo {
  path: string;
  name: string;
  isGitRepo: boolean;
}

export interface DialogAPI {
  selectFolders: () => Promise<FolderInfo[]>;
  selectFolder: () => Promise<FolderInfo | null>;
}

export interface FileAPI {
  readFile: (filePath: string) => Promise<string>;
  listDirectory: (
    dirPath: string,
  ) => Promise<Array<{ name: string; path: string; isDirectory: boolean }>>;
}

export type GitFileStatus = 'staged' | 'modified' | 'untracked' | 'deleted';

export interface GitStatusResult {
  files: Array<{ path: string; status: GitFileStatus }>;
  stats: { modifiedCount: number; addedLines: number; removedLines: number };
  isGitRepo: boolean;
  branch: string | null;
}

export interface GitDiffHunk {
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

export interface GitDiffResult {
  filePath: string;
  staged: boolean;
  oldContent: string;
  newContent: string;
  hunks: GitDiffHunk[];
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
}

export interface AttentionAPI {
  getSnapshot: () => Promise<AttentionState>;
  onChanged: (callback: (change: AttentionChange) => void) => () => void;
  setViewing: (instanceId: string | null) => void;
  setFocused: (focused: boolean) => void;
  settle: (workspaceId: string, sessionId: string) => Promise<SettleResult>;
  unsettle: (workspaceId: string, sessionId: string) => Promise<SettleMemento>;
  restore: (memento: SettleMemento) => Promise<void>;
  snooze: (
    workspaceId: string,
    sessionIds: string[],
    when: SnoozeWhen,
  ) => Promise<SnoozeBatchResult>;
  wake: (workspaceId: string, sessionIds: string[]) => Promise<BatchResult>;
  settleMany: (workspaceId: string, sessionIds: string[]) => Promise<SettleBatchResult>;
  unsettleMany: (workspaceId: string, sessionIds: string[]) => Promise<BatchResult>;
}

export interface UsageLimitsAPI {
  getSnapshot: () => Promise<UsageLimitsState>;
  onChanged: (callback: (state: UsageLimitsState) => void) => () => void;
}

export interface WorktreeCleanupAPI {
  preview: (request: CleanupPreviewRequest) => Promise<CleanupPreview>;
  run: (workspaceId?: string) => Promise<CleanupReport>;
  history: (workspaceId?: string) => Promise<CleanupHistoryEntry[]>;
  isManaged: (dir: string) => Promise<boolean>;
  onDeleted: (callback: (outcome: SessionDeleteOutcome) => void) => () => void;
  onChanged: (callback: () => void) => () => void;
}

export interface PreferencesAPI {
  get: () => Promise<Preferences>;
  setWorktreeCleanup: (rules: WorktreeCleanupRules) => Promise<void>;
  setTerminalLinks: (rule: TerminalLinkRule) => Promise<void>;
  setAutoSettleDays: (days: number) => Promise<void>;
  acknowledgeAutoSettle: () => Promise<void>;
  setSnoozePresets: (presets: SnoozePresetSetting[]) => Promise<void>;
  setSnoozeAtUsageLimit: (on: boolean) => Promise<void>;
  onChanged: (callback: (preferences: Preferences) => void) => () => void;
}

export interface GitAPI {
  getStatus: (rootPath: string) => Promise<GitStatusResult>;
  getCheckout: (dir: string) => Promise<CheckoutInfo>;
  /** Push and base counts, compared with what the clone last fetched; never fetches. */
  getBranchFacts: (dir: string, baseBranch?: string) => Promise<BranchFacts>;
  getDiff: (rootPath: string, filePath: string, staged: boolean) => Promise<GitDiffResult>;
  stageFile: (rootPath: string, filePath: string) => Promise<{ success: boolean }>;
  unstageFile: (rootPath: string, filePath: string) => Promise<{ success: boolean }>;
  commit: (rootPath: string, message: string) => Promise<{ success: boolean; error?: string }>;
  getStagedDiff: (rootPath: string) => Promise<{ stagedFiles: string[]; diff: string }>;
  generateCommitMessage: (rootPath: string) => Promise<{ message: string; error?: string }>;
}

declare global {
  interface Window {
    appUpdateAPI?: AppUpdateAPI;
    browserAPI: BrowserAPI;
    dialogAPI: DialogAPI;
    fileAPI: FileAPI;
    attentionAPI: AttentionAPI;
    preferencesAPI: PreferencesAPI;
    worktreeCleanupAPI: WorktreeCleanupAPI;
    usageLimitsAPI?: UsageLimitsAPI;
    gitAPI: GitAPI;
    openInAPI: OpenInAPI;
  }
}
