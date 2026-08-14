import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface Session {
  id: string;
  name: string;                    // From Claude's session summary, or user-provided
  workspaceId: string;             // Parent workspace
  instanceId: string;              // Terminal instance ID
  claudeSessionId: string;         // UUID passed to `claude --session-id`
  hasStarted: boolean;             // Launched before, so resume instead of create
  createdAt: number;
  lastActiveAt: number;
}

export interface Workspace {
  id: string;
  name: string;                    // From folder name
  path: string;                    // Absolute folder path (1:1 relationship)
  isGitRepo: boolean;              // Whether .git folder exists
  sessions: Session[];
  createdAt: number;
  updatedAt: number;
}

interface WorkspaceState {
  workspaces: Workspace[];
  createWorkspace: (name: string, path: string, isGitRepo: boolean) => Workspace;
  deleteWorkspace: (id: string) => void;
  updateWorkspace: (id: string, updates: Partial<Pick<Workspace, 'name'>>) => void;
  getWorkspace: (id: string) => Workspace | undefined;
  // Session management
  createSession: (workspaceId: string, session: Omit<Session, 'id' | 'createdAt' | 'lastActiveAt' | 'claudeSessionId' | 'hasStarted'>) => Session | undefined;
  updateSession: (workspaceId: string, sessionId: string, updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>) => void;
  deleteSession: (workspaceId: string, sessionId: string) => void;
  getSession: (workspaceId: string, sessionId: string) => Session | undefined;
  getWorkspaceSessions: (workspaceId: string) => Session[];
  updateSessionActivity: (workspaceId: string, sessionId: string) => void;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

/**
 * A session ID for `claude --session-id`, which requires a valid UUID.
 *
 * Assigning it here — rather than discovering it after the fact — is what lets a
 * tab reconnect to its conversation with `--resume` on the next launch.
 */
function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for contexts where randomUUID is unavailable.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      createWorkspace: (name, path, isGitRepo) => {
        const now = Date.now();
        const workspace: Workspace = {
          id: generateId(),
          name,
          path,
          isGitRepo,
          sessions: [],
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          workspaces: [...state.workspaces, workspace],
        }));
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
        const now = Date.now();
        const session: Session = {
          id: generateId(),
          ...sessionData,
          claudeSessionId: generateUuid(),
          hasStarted: false,
          createdAt: now,
          lastActiveAt: now,
        };
        let createdSession: Session | undefined;
        set((state) => ({
          workspaces: state.workspaces.map((ws) => {
            if (ws.id === workspaceId) {
              createdSession = session;
              return {
                ...ws,
                sessions: [...ws.sessions, session],
                updatedAt: now,
              };
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
      // Migration: v2 -> v3 removes projects and adds path to workspace;
      // v3 -> v4 gives every session a Claude session UUID.
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as { workspaces: unknown[] };
        if (state.workspaces && version < 4) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          state.workspaces = state.workspaces.map((ws: any) => {
            // If workspace has no path, try to get it from first project
            if (!ws.path && ws.projects && ws.projects.length > 0) {
              const firstProject = ws.projects[0];
              return {
                id: ws.id,
                name: ws.name,
                path: firstProject.path,
                isGitRepo: firstProject.isGitRepo ?? false,
                sessions: (ws.sessions ?? []).map((s: Record<string, unknown>) => ({
                  id: s.id,
                  name: s.name,
                  workspaceId: s.workspaceId,
                  instanceId: s.instanceId,
                  createdAt: s.createdAt,
                  lastActiveAt: s.lastActiveAt,
                })),
                createdAt: ws.createdAt,
                updatedAt: ws.updatedAt,
              };
            }
            // Workspace already has path or no projects - ensure correct shape
            return {
              id: ws.id,
              name: ws.name,
              path: ws.path ?? '',
              isGitRepo: ws.isGitRepo ?? false,
              sessions: (ws.sessions ?? []).map((s: Record<string, unknown>) => ({
                id: s.id,
                name: s.name,
                workspaceId: s.workspaceId,
                instanceId: s.instanceId,
                // Pre-v4 sessions have no Claude conversation of their own:
                // their history lived in Consola's database. They get a fresh
                // session ID and start a new conversation.
                claudeSessionId: (s.claudeSessionId as string) ?? generateUuid(),
                hasStarted: (s.hasStarted as boolean) ?? false,
                createdAt: s.createdAt,
                lastActiveAt: s.lastActiveAt,
              })),
              createdAt: ws.createdAt,
              updatedAt: ws.updatedAt,
            };
          });
        }
        return state;
      },
      version: 4,
    }
  )
);
