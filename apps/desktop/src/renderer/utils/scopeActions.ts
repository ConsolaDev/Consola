import { dialogBridge } from '../services/dialogBridge';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useShellStore } from '../stores/shellStore';
import { useTerminalStore } from '../stores/terminalStore';
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

/** Main stops the sessions; clear their local view state after the write succeeds. */
export async function deleteScopeCompletely(workspaceId: string, scopeId: string): Promise<void> {
  const store = useWorkspaceStore.getState();
  const sessions = store.getWorkspaceSessions(workspaceId).filter(session => session.scopeId === scopeId);
  await store.removeScope(workspaceId, scopeId);

  for (const session of sessions) {
    useShellStore.getState().remove(session.instanceId);
    useTerminalStore.getState().removeInstance(session.instanceId);
  }
  const navigation = useNavigationStore.getState();
  if (navigation.activeWorkspaceId === workspaceId && sessions.some(session => session.id === navigation.activeSessionId)) {
    navigation.setActiveSession(null);
  }
}
