import { create } from 'zustand';
import { primaryScope, type Workspace } from '../../shared/workspace';

interface HomeState {
  scopeIds: Record<string, string>;
  tabs: Record<string, 'home' | 'all'>;
  draftGroupIds: Record<string, string | undefined>;
  selectScope: (workspaceId: string, scopeId: string) => void;
  selectTab: (workspaceId: string, tab: 'home' | 'all') => void;
  setDraftGroup: (workspaceId: string, groupId?: string) => void;
}

// Window-local context: switching workspaces keeps each one's selection without
// sharing a window's current filter or draft destination with other windows.
export const useHomeStore = create<HomeState>((set) => ({
  scopeIds: {},
  tabs: {},
  draftGroupIds: {},
  selectScope: (id, scopeId) => set(state => ({ scopeIds: { ...state.scopeIds, [id]: scopeId } })),
  selectTab: (id, tab) => set(state => ({ tabs: { ...state.tabs, [id]: tab } })),
  setDraftGroup: (id, groupId) => set(state => ({ draftGroupIds: { ...state.draftGroupIds, [id]: groupId } })),
}));

export function homeScope(workspace: Workspace, selectedId?: string, activeSessionId?: string | null) {
  return workspace.scopes.find(scope => scope.id === selectedId)
    ?? workspace.scopes.find(scope => scope.id === workspace.sessions.find(session => session.id === activeSessionId)?.scopeId)
    ?? primaryScope(workspace);
}
