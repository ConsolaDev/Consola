export interface FolderInfo {
  path: string;
  name: string;
  isGitRepo: boolean;
}

export interface DialogAPI {
  selectFolders: () => Promise<FolderInfo[]>;
}

declare global {
  interface Window {
    dialogAPI: DialogAPI;
  }
}
