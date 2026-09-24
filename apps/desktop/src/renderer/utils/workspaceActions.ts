import { dialogBridge } from '../services/dialogBridge';
import { useWorkspaceStore, type Workspace } from '../stores/workspaceStore';
import { useNavigationStore } from '../stores/navigationStore';
import type { FolderInfo } from '../types/electron';

/**
 * Create a workspace whose scopes are the given folders, and switch to it.
 *
 * The first folder seeds the workspace through the one-folder creation path;
 * the rest arrive as extra scopes. A custom name is applied afterwards rather
 * than passed in, because creation names the first scope after the workspace
 * and that scope should keep its folder's name.
 */
export async function createWorkspaceFromFolders(
  folders: FolderInfo[],
  name?: string
): Promise<Workspace | undefined> {
  const [first, ...rest] = folders;
  if (!first) return undefined;
  const store = useWorkspaceStore.getState();
  const workspace = await store.createWorkspace(first.name, first.path, first.isGitRepo);
  for (const folder of rest) {
    await store.addScope(workspace.id, { name: folder.name, path: folder.path, isGitRepo: folder.isGitRepo });
  }
  const trimmed = name?.trim();
  if (trimmed && trimmed !== workspace.name) await store.updateWorkspace(workspace.id, { name: trimmed });
  await useNavigationStore.getState().setActiveWorkspace(workspace.id);
  return workspace;
}

/**
 * Pick one or more folders and turn them straight into a workspace.
 *
 * The quick door — the rail's ＋ and ⌘N with no workspace open. The welcome
 * screen offers the same thing with a chance to review and name it first.
 */
export async function pickFoldersAndCreateWorkspace(): Promise<Workspace | undefined> {
  const folders = await dialogBridge.selectFolders();
  return createWorkspaceFromFolders(folders);
}
