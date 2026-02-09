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
  listDirectory: (dirPath: string) => Promise<Array<{ name: string; path: string; isDirectory: boolean }>>;
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

export interface GitAPI {
  getStatus: (rootPath: string) => Promise<GitStatusResult>;
  getDiff: (rootPath: string, filePath: string, staged: boolean) => Promise<GitDiffResult>;
  stageFile: (rootPath: string, filePath: string) => Promise<{ success: boolean }>;
  unstageFile: (rootPath: string, filePath: string) => Promise<{ success: boolean }>;
  commit: (rootPath: string, message: string) => Promise<{ success: boolean; error?: string }>;
  getStagedDiff: (rootPath: string) => Promise<{ stagedFiles: string[]; diff: string }>;
  generateCommitMessage: (rootPath: string, instanceId: string) => Promise<{ message: string; error?: string }>;
}

export interface PersistedSessionData {
  messages: unknown[];
  toolHistory: unknown[];
}

export interface SessionStorageAPI {
  saveHistory: (sessionId: string, data: PersistedSessionData) => Promise<void>;
  loadHistory: (sessionId: string) => Promise<PersistedSessionData | null>;
  deleteHistory: (sessionId: string) => Promise<void>;
  generateName: (query: string) => Promise<{ name: string }>;
}

declare global {
  interface Window {
    dialogAPI: DialogAPI;
    fileAPI: FileAPI;
    gitAPI: GitAPI;
    sessionStorageAPI: SessionStorageAPI;
  }
}
