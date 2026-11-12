import { create } from 'zustand';
import { primaryScope, type Workspace } from '../../shared/workspace';

interface HomeState {
  scopeIds: Record<string, string>;
  draftGroupIds: Record<string, string | undefined>;
  selectScope: (workspaceId: string, scopeId: string) => void;
  setDraftGroup: (workspaceId: string, groupId?: string) => void;
}

// Window-local context: switching workspaces keeps each one's selection without
// sharing a window's current filter or draft destination with other windows.
export const useHomeStore = create<HomeState>((set) => ({
  scopeIds: {},
  draftGroupIds: {},
  selectScope: (id, scopeId) => set(state => ({ scopeIds: { ...state.scopeIds, [id]: scopeId } })),
  setDraftGroup: (id, groupId) => set(state => ({ draftGroupIds: { ...state.draftGroupIds, [id]: groupId } })),
}));

export function homeScope(workspace: Workspace, selectedId?: string, activeSessionId?: string | null) {
  return workspace.scopes.find(scope => scope.id === selectedId)
    ?? workspace.scopes.find(scope => scope.id === workspace.sessions.find(session => session.id === activeSessionId)?.scopeId)
    ?? primaryScope(workspace);
}
