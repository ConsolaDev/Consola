import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type ViewType = 'home' | 'workspace' | 'settings';

interface NavigationState {
  isSidebarCollapsed: boolean;
  expandedWorkspaces: Record<string, boolean>;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleWorkspaceExpanded: (workspaceId: string) => void;
  setWorkspaceExpanded: (workspaceId: string, expanded: boolean) => void;
  isWorkspaceExpanded: (workspaceId: string) => boolean;
}

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set, get) => ({
      isSidebarCollapsed: false,
      expandedWorkspaces: {},
      toggleSidebar: () => set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ isSidebarCollapsed: collapsed }),
      toggleWorkspaceExpanded: (workspaceId) =>
        set((state) => ({
          expandedWorkspaces: {
            ...state.expandedWorkspaces,
            [workspaceId]: !get().isWorkspaceExpanded(workspaceId),
          },
        })),
      setWorkspaceExpanded: (workspaceId, expanded) =>
        set((state) => ({
          expandedWorkspaces: {
            ...state.expandedWorkspaces,
            [workspaceId]: expanded,
          },
        })),
      isWorkspaceExpanded: (workspaceId) => {
        const state = get();
        // Default to true (expanded) for new workspaces
        return state.expandedWorkspaces[workspaceId] ?? true;
      },
    }),
    {
      name: 'console-1-navigation',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        isSidebarCollapsed: state.isSidebarCollapsed,
        expandedWorkspaces: state.expandedWorkspaces,
      }),
    }
  )
);
