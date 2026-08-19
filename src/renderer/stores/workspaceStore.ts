import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { BUILT_IN_HARNESS_ID } from '../../shared/constants';
import {
  CURRENT_WORKSPACE_STATE_VERSION,
  createSessionRecord,
  createWorkspaceRecord,
  migrateWorkspaceState,
} from '../../shared/workspace';
import type { Session, Workspace } from '../../shared/workspace';

// Fourteen files import these from here. Re-exported rather than relocated so
// this task stays a move, not a rename sweep.
export type { Session, Workspace } from '../../shared/workspace';
export { migrateWorkspaceState } from '../../shared/workspace';

interface WorkspaceState {
  workspaces: Workspace[];
  createWorkspace: (
    name: string,
    path: string,
    isGitRepo: boolean,
    defaultHarnessId?: string
  ) => Workspace;
  deleteWorkspace: (id: string) => void;
  updateWorkspace: (
    id: string,
    updates: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>>
  ) => void;
  getWorkspace: (id: string) => Workspace | undefined;
  // Session management
  createSession: (workspaceId: string, session: Omit<Session, 'id' | 'createdAt' | 'lastActiveAt' | 'claudeSessionId' | 'hasStarted'>) => Session | undefined;
  updateSession: (workspaceId: string, sessionId: string, updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>) => void;
  deleteSession: (workspaceId: string, sessionId: string) => void;
  getSession: (workspaceId: string, sessionId: string) => Session | undefined;
  getWorkspaceSessions: (workspaceId: string) => Session[];
  updateSessionActivity: (workspaceId: string, sessionId: string) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      createWorkspace: (name, path, isGitRepo, defaultHarnessId = BUILT_IN_HARNESS_ID) => {
        const workspace = createWorkspaceRecord(name, path, isGitRepo, defaultHarnessId);
        set((state) => ({ workspaces: [...state.workspaces, workspace] }));
        return workspace;
      },
      deleteWorkspace: (id) => {
        set((state) => ({
          workspaces: state.workspaces.filter((ws) => ws.id !== id),
        }));
      },
      updateWorkspace: (id, updates) => {
        set((state) => ({
          workspaces: state.workspaces.map((ws) =>
            ws.id === id
              ? { ...ws, ...updates, updatedAt: Date.now() }
              : ws
          ),
        }));
      },
      getWorkspace: (id) => {
        return get().workspaces.find((ws) => ws.id === id);
      },

      // Session management
      createSession: (workspaceId, sessionData) => {
        const session = createSessionRecord(sessionData);
        const now = session.createdAt;
        let createdSession: Session | undefined;
        set((state) => ({
          workspaces: state.workspaces.map((ws) => {
            if (ws.id === workspaceId) {
              createdSession = session;
              return { ...ws, sessions: [...ws.sessions, session], updatedAt: now };
            }
            return ws;
          }),
        }));
        return createdSession;
      },

      updateSession: (workspaceId, sessionId, updates) => {
        const now = Date.now();
        set((state) => ({
          workspaces: state.workspaces.map((ws) => {
            if (ws.id === workspaceId) {
              return {
                ...ws,
                sessions: ws.sessions.map((s) =>
                  s.id === sessionId ? { ...s, ...updates } : s
                ),
                updatedAt: now,
              };
            }
            return ws;
          }),
        }));
      },

      deleteSession: (workspaceId, sessionId) => {
        const now = Date.now();
        set((state) => ({
          workspaces: state.workspaces.map((ws) => {
            if (ws.id === workspaceId) {
              return {
                ...ws,
                sessions: ws.sessions.filter((s) => s.id !== sessionId),
                updatedAt: now,
              };
            }
            return ws;
          }),
        }));
      },

      getSession: (workspaceId, sessionId) => {
        const workspace = get().workspaces.find((ws) => ws.id === workspaceId);
        return workspace?.sessions.find((s) => s.id === sessionId);
      },

      getWorkspaceSessions: (workspaceId) => {
        const workspace = get().workspaces.find((ws) => ws.id === workspaceId);
        return workspace?.sessions ?? [];
      },

      updateSessionActivity: (workspaceId, sessionId) => {
        const now = Date.now();
        set((state) => ({
          workspaces: state.workspaces.map((ws) => {
            if (ws.id === workspaceId) {
              return {
                ...ws,
                sessions: ws.sessions.map((s) =>
                  s.id === sessionId ? { ...s, lastActiveAt: now } : s
                ),
              };
            }
            return ws;
          }),
        }));
      },
    }),
    {
      name: 'consola-workspaces',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ workspaces: state.workspaces }),
      migrate: migrateWorkspaceState,
      version: CURRENT_WORKSPACE_STATE_VERSION,
    }
  )
);
