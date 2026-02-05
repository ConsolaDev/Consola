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

export interface GitAPI {
  getStatus: (rootPath: string) => Promise<GitStatusResult>;
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
