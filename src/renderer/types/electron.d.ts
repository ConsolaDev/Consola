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

declare global {
  interface Window {
    dialogAPI: DialogAPI;
    fileAPI: FileAPI;
  }
}
