export interface FolderInfo {
  path: string;
  name: string;
  isGitRepo: boolean;
}

export interface DialogAPI {
  selectFolders: () => Promise<FolderInfo[]>;
}

export interface FileAPI {
  readFile: (filePath: string) => Promise<string>;
}

export type GitFileStatus = 'staged' | 'modified' | 'untracked' | 'deleted';

export interface GitStatusResult {
  files: Array<{ path: string; status: GitFileStatus }>;
  stats: { modifiedCount: number; addedLines: number; removedLines: number };
  isGitRepo: boolean;
}

export interface GitAPI {
  getStatus: (rootPath: string) => Promise<GitStatusResult>;
}

declare global {
  interface Window {
    dialogAPI: DialogAPI;
    fileAPI: FileAPI;
    gitAPI: GitAPI;
  }
}
