import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type ViewType = 'home' | 'workspace' | 'settings';

interface NavigationState {
  isSidebarHidden: boolean;
  isExplorerVisible: boolean;
  expandedWorkspaces: Record<string, boolean>;
  toggleSidebar: () => void;
  setSidebarHidden: (hidden: boolean) => void;
  toggleExplorer: () => void;
  setExplorerVisible: (visible: boolean) => void;
  toggleWorkspaceExpanded: (workspaceId: string) => void;
  setWorkspaceExpanded: (workspaceId: string, expanded: boolean) => void;
  isWorkspaceExpanded: (workspaceId: string) => boolean;
}

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set, get) => ({
      isSidebarHidden: false,
      isExplorerVisible: false,
      expandedWorkspaces: {},
      toggleSidebar: () => set((state) => ({ isSidebarHidden: !state.isSidebarHidden })),
      setSidebarHidden: (hidden) => set({ isSidebarHidden: hidden }),
      toggleExplorer: () => set((state) => ({ isExplorerVisible: !state.isExplorerVisible })),
      setExplorerVisible: (visible) => set({ isExplorerVisible: visible }),
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
      name: 'consola-navigation',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        isSidebarHidden: state.isSidebarHidden,
        isExplorerVisible: state.isExplorerVisible,
        expandedWorkspaces: state.expandedWorkspaces,
      }),
    }
  )
);
