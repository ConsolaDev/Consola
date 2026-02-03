import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

interface WorkspaceState {
  workspaces: Workspace[];
  createWorkspace: (name: string) => Workspace;
  deleteWorkspace: (id: string) => void;
  updateWorkspace: (id: string, updates: Partial<Pick<Workspace, 'name'>>) => void;
  getWorkspace: (id: string) => Workspace | undefined;
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
    }),
    {
      name: 'console-1-workspaces',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ workspaces: state.workspaces }),
    }
  )
);
