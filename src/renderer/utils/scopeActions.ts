import { dialogBridge } from '../services/dialogBridge';
import { useWorkspaceStore } from '../stores/workspaceStore';
import type { Scope } from '../../shared/workspace';

/**
 * Pick a folder and add it to a workspace as a scope.
 *
 * Shared by the sidebar's + button and the settings Scopes panel so the two
 * doors cannot drift. Resolves undefined when the picker is cancelled; a
 * refused add rejects so each caller can surface it its own way.
 */
export async function addScopeViaDialog(workspaceId: string): Promise<Scope | undefined> {
  const folder = await dialogBridge.selectFolder();
  if (!folder) return undefined;
  return useWorkspaceStore.getState().addScope(workspaceId, {
    name: folder.name,
    path: folder.path,
    isGitRepo: folder.isGitRepo,
  });
}
