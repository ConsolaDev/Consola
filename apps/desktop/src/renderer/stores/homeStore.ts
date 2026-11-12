import { create } from 'zustand';
import { primaryScope, type Scope, type Workspace } from '../../shared/workspace';

interface HomeState {
  /** Workspace id → the one scope its session list is narrowed to. No key is "All scopes". */
  scopeFilters: Record<string, string>;
  draftGroupIds: Record<string, string | undefined>;
  setScopeFilter: (workspaceId: string, scopeId: string | null) => void;
  setDraftGroup: (workspaceId: string, groupId?: string) => void;
}

// Window-local context: switching workspaces keeps each one's filter without
// sharing a window's current filter or draft destination with other windows.
export const useHomeStore = create<HomeState>((set) => ({
  scopeFilters: {},
  draftGroupIds: {},
  setScopeFilter: (id, scopeId) => set(state => {
    const { [id]: _previous, ...rest } = state.scopeFilters;
    return { scopeFilters: scopeId === null ? rest : { ...rest, [id]: scopeId } };
  }),
  setDraftGroup: (id, groupId) => set(state => ({ draftGroupIds: { ...state.draftGroupIds, [id]: groupId } })),
}));

/**
 * The scope the session list is narrowed to, or undefined for All scopes.
 * A filter whose scope was removed reads as All, so nothing has to clean it up.
 */
export function filteredScope(workspace: Workspace, filterId?: string): Scope | undefined {
  return workspace.scopes.find(scope => scope.id === filterId);
}

/**
 * Where a new session starts: the preferred scope (an explicit destination or
 * the filter), else the open session's scope, else the primary scope. The
 * Assistant runs no scope, so it never lends its record's scopeId.
 */
export function newSessionScope(workspace: Workspace, preferredScopeId?: string, activeSessionId?: string | null): Scope | undefined {
  const open = workspace.sessions.find(session => session.id === activeSessionId);
  return workspace.scopes.find(scope => scope.id === preferredScopeId)
    ?? (open && open.kind !== 'assistant' ? workspace.scopes.find(scope => scope.id === open.scopeId) : undefined)
    ?? primaryScope(workspace);
}

/** With one scope there is nothing to tell apart: no scope names on rows, no scope list in ▾. */
export function hasScopeChoice(workspace: Workspace): boolean {
  return workspace.scopes.length >= 2;
}
