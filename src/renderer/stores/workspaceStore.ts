import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface Project {
  id: string;
  name: string;           // Display name (folder name by default)
  path: string;           // Absolute folder path
  isGitRepo: boolean;     // Whether .git folder exists
  createdAt: number;
  lastOpenedAt: number;
}

export interface Workspace {
  id: string;
  name: string;
  projects: Project[];
  createdAt: number;
  updatedAt: number;
}

interface WorkspaceState {
  workspaces: Workspace[];
  createWorkspace: (name: string) => Workspace;
  deleteWorkspace: (id: string) => void;
  updateWorkspace: (id: string, updates: Partial<Pick<Workspace, 'name'>>) => void;
  getWorkspace: (id: string) => Workspace | undefined;
  addProjectToWorkspace: (workspaceId: string, project: Omit<Project, 'id' | 'createdAt' | 'lastOpenedAt'>) => Project | undefined;
  removeProjectFromWorkspace: (workspaceId: string, projectId: string) => void;
  updateProjectLastOpened: (workspaceId: string, projectId: string) => void;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      createWorkspace: (name) => {
        const now = Date.now();
        const workspace: Workspace = {
          id: generateId(),
          name,
          projects: [],
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
      addProjectToWorkspace: (workspaceId, projectData) => {
        const now = Date.now();
        const project: Project = {
          id: generateId(),
          ...projectData,
          createdAt: now,
          lastOpenedAt: now,
        };
        let addedProject: Project | undefined;
        set((state) => ({
          workspaces: state.workspaces.map((ws) => {
            if (ws.id === workspaceId) {
              addedProject = project;
              return {
                ...ws,
                projects: [...ws.projects, project],
                updatedAt: now,
              };
            }
            return ws;
          }),
        }));
        return addedProject;
      },
      removeProjectFromWorkspace: (workspaceId, projectId) => {
        set((state) => ({
          workspaces: state.workspaces.map((ws) => {
            if (ws.id === workspaceId) {
              return {
                ...ws,
                projects: ws.projects.filter((p) => p.id !== projectId),
                updatedAt: Date.now(),
              };
            }
            return ws;
          }),
        }));
      },
      updateProjectLastOpened: (workspaceId, projectId) => {
        const now = Date.now();
        set((state) => ({
          workspaces: state.workspaces.map((ws) => {
            if (ws.id === workspaceId) {
              return {
                ...ws,
                projects: ws.projects.map((p) =>
                  p.id === projectId ? { ...p, lastOpenedAt: now } : p
                ),
                updatedAt: now,
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
      // Migration: add projects array to existing workspaces
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as { workspaces: Workspace[] };
        if (state.workspaces) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            projects: ws.projects ?? [],
          }));
        }
        return state;
      },
      version: 1,
    }
  )
);
