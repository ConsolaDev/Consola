import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { windowBridge } from '../services/windowBridge';

/**
 * What this window is showing, and how it is laid out.
 *
 * The two are persisted differently on purpose. Sidebar and explorer
 * visibility are preferences and are shared by every window, where a
 * last-writer-wins race is harmless. Which workspace and session a window holds
 * is that window's identity: it arrives from main at construction and is
 * remembered by main, because localStorage is shared and two windows writing
 * their own identity into one key would each read the other's.
 */
export interface NavigationState {
  isSidebarHidden: boolean;
  isExplorerVisible: boolean;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  toggleSidebar: () => void;
  setSidebarHidden: (hidden: boolean) => void;
  toggleExplorer: () => void;
  setExplorerVisible: (visible: boolean) => void;
  /** Ask main for the workspace. Resolves once the verdict is known. */
  setActiveWorkspace: (id: string | null) => Promise<void>;
  setActiveSession: (id: string | null) => void;
  // Read only by WorkspaceNavItem, which Task 12 deletes along with these.
  expandedWorkspaces: Record<string, boolean>;
  toggleWorkspaceExpanded: (workspaceId: string) => void;
  setWorkspaceExpanded: (workspaceId: string, expanded: boolean) => void;
  isWorkspaceExpanded: (workspaceId: string) => boolean;
}

/**
 * Fold a persisted blob into fresh state, taking preferences only.
 *
 * Identity — which workspace and session a window holds — belongs to the
 * window and arrives from main at construction. localStorage is shared by
 * every window, and blobs written by builds before that was true still carry
 * those keys, so merging them back would hand every window the same workspace
 * and leave main's registry disagreeing with what is on screen.
 *
 * Exported so this can be exercised on its own: it is the one place a stale
 * profile can defeat per-window identity.
 */
export function mergeNavigationState(
  persisted: unknown,
  current: NavigationState
): NavigationState {
  const saved = (persisted ?? {}) as Partial<NavigationState>;
  return {
    ...current,
    ...(typeof saved.isSidebarHidden === 'boolean'
      ? { isSidebarHidden: saved.isSidebarHidden }
      : {}),
    ...(typeof saved.isExplorerVisible === 'boolean'
      ? { isExplorerVisible: saved.isExplorerVisible }
      : {}),
  };
}

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set, get) => ({
      isSidebarHidden: false,
      isExplorerVisible: false,
      activeWorkspaceId: windowBridge.context.workspaceId,
      activeSessionId: windowBridge.context.activeSessionId,
      expandedWorkspaces: {},

      toggleSidebar: () => set((state) => ({ isSidebarHidden: !state.isSidebarHidden })),
      setSidebarHidden: (hidden) => set({ isSidebarHidden: hidden }),
      toggleExplorer: () => set((state) => ({ isExplorerVisible: !state.isExplorerVisible })),
      setExplorerVisible: (visible) => set({ isExplorerVisible: visible }),

      setActiveWorkspace: async (id) => {
        const verdict = await windowBridge.activateWorkspace(id);
        // 'focused-elsewhere' means another window already holds it and has
        // been brought forward. This window keeps showing what it was showing.
        if (verdict === 'took') {
          set({ activeWorkspaceId: id, activeSessionId: null });
          windowBridge.setActiveSession(null);
        }
      },

      setActiveSession: (id) => {
        set({ activeSessionId: id });
        windowBridge.setActiveSession(id);
      },

      toggleWorkspaceExpanded: (workspaceId) =>
        set((state) => ({
          expandedWorkspaces: {
            ...state.expandedWorkspaces,
            [workspaceId]: !get().isWorkspaceExpanded(workspaceId),
          },
        })),
      setWorkspaceExpanded: (workspaceId, expanded) =>
        set((state) => ({
          expandedWorkspaces: { ...state.expandedWorkspaces, [workspaceId]: expanded },
        })),
      isWorkspaceExpanded: (workspaceId) => get().expandedWorkspaces[workspaceId] ?? true,
    }),
    {
      name: 'consola-navigation',
      storage: createJSONStorage(() => localStorage),
      // Identity is deliberately absent: it belongs to the window, not the app.
      // expandedWorkspaces is absent too — it is about to stop existing.
      partialize: (state) => ({
        isSidebarHidden: state.isSidebarHidden,
        isExplorerVisible: state.isExplorerVisible,
      }),
      // partialize only governs writes. zustand's default merge spreads the
      // *raw* persisted blob over fresh state on every hydrate, so a profile
      // written before this task would still overwrite the window-context-seeded
      // identity with whatever workspace that blob last held. mergeNavigationState
      // takes only the two preference keys, and only when they're the right type.
      merge: (persisted, current) => mergeNavigationState(persisted, current as NavigationState),
    }
  )
);

/** React to main dropping this window's workspace, e.g. after a delete. */
export function subscribeToWindowWorkspace(): () => void {
  return windowBridge.onWorkspaceChanged((workspaceId) => {
    useNavigationStore.setState({ activeWorkspaceId: workspaceId, activeSessionId: null });
  });
}
