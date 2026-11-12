import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { windowBridge } from '../services/windowBridge';
import type { WorkspaceOverlay } from '../../shared/types';
import { useAutomationsStore } from './automationsStore';

/**
 * Bounds for the sidebar width, in pixels.
 *
 * Below 180px the header strip above the sidebar — traffic-light gutter plus
 * the toggle button — no longer fits, and session names truncate to nothing;
 * above 480px the sidebar starts crowding the terminal on a laptop display.
 * The default matches the static `--sidebar-width` token, which is what paints
 * before a persisted value has been read.
 */
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 240;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

/**
 * What this window is showing, and how it is laid out.
 *
 * The two are persisted differently on purpose. Sidebar visibility and width,
 * and explorer and work-item panel visibility, are preferences and are shared
 * by every window,
 * where a last-writer-wins race is harmless. Which workspace and session a window holds
 * is that window's identity: it arrives from main at construction and is
 * remembered by main, because localStorage is shared and two windows writing
 * their own identity into one key would each read the other's.
 */
export interface NavigationState {
  isSidebarHidden: boolean;
  /** Pixel width of the sidebar when shown; kept while it is hidden. */
  sidebarWidth: number;
  isExplorerVisible: boolean;
  /**
   * Show a linked session's PR or issue beside its terminal. A preference,
   * like the explorer: it applies to every session that has a work item.
   */
  isWorkItemPanelVisible: boolean;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  /**
   * The Inbox or Automations is showing over the pane; the session below stays active.
   * Per-window like the session, and remembered by main against the workspace.
   */
  overlay: WorkspaceOverlay;
  toggleSidebar: () => void;
  setSidebarHidden: (hidden: boolean) => void;
  setSidebarWidth: (width: number) => void;
  toggleExplorer: () => void;
  setExplorerVisible: (visible: boolean) => void;
  toggleWorkItemPanel: () => void;
  setWorkItemPanelVisible: (visible: boolean) => void;
  /** Ask main for the workspace. Resolves once the verdict is known. */
  setActiveWorkspace: (id: string | null) => Promise<void>;
  setActiveSession: (id: string | null) => void;
  openInbox: () => void;
  openAutomations: () => void;
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
    // Clamped rather than rejected: a width written before the bounds changed
    // still has to land on something the layout can show.
    ...(typeof saved.sidebarWidth === 'number'
      ? { sidebarWidth: clampSidebarWidth(saved.sidebarWidth) }
      : {}),
    ...(typeof saved.isExplorerVisible === 'boolean'
      ? { isExplorerVisible: saved.isExplorerVisible }
      : {}),
    ...(typeof saved.isWorkItemPanelVisible === 'boolean'
      ? { isWorkItemPanelVisible: saved.isWorkItemPanelVisible }
      : {}),
  };
}

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set, get) => ({
      isSidebarHidden: false,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      isExplorerVisible: false,
      isWorkItemPanelVisible: false,
      activeWorkspaceId: windowBridge.context.workspaceId,
      // Both arrive with the window, so the first paint already shows what
      // this workspace was left on rather than an empty view it corrects later.
      activeSessionId: windowBridge.context.activeSessionId,
      overlay: windowBridge.context.overlay,

      toggleSidebar: () => set((state) => ({ isSidebarHidden: !state.isSidebarHidden })),
      setSidebarHidden: (hidden) => set({ isSidebarHidden: hidden }),
      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
      toggleExplorer: () => set((state) => ({ isExplorerVisible: !state.isExplorerVisible })),
      setExplorerVisible: (visible) => set({ isExplorerVisible: visible }),
      toggleWorkItemPanel: () =>
        set((state) => ({ isWorkItemPanelVisible: !state.isWorkItemPanelVisible })),
      setWorkItemPanelVisible: (visible) => set({ isWorkItemPanelVisible: visible }),

      setActiveWorkspace: async (id) => {
        const result = await windowBridge.activateWorkspace(id);
        // 'focused-elsewhere' means another window already holds it and has
        // been brought forward. This window keeps showing what it was showing.
        if (result.verdict !== 'took') return;
        closePanelOnWorkspaceSwitch(get().activeWorkspaceId, id);
        // Adopted, not cleared: main answered with what this workspace was
        // last showing, already narrowed to what it can still show. Nothing is
        // reported back — main is where this just came from.
        set({
          activeWorkspaceId: id,
          activeSessionId: result.view.activeSessionId,
          overlay: result.view.overlay,
        });
      },

      setActiveSession: (id) => {
        set({ activeSessionId: id, overlay: null });
        // Reported even when `id` is null: backing out to the workspace on
        // purpose is a state worth returning to, not an absence of one.
        windowBridge.setView(get().activeWorkspaceId, {
          activeSessionId: id,
          overlay: null,
        });
      },

      openInbox: () => {
        set({ overlay: 'inbox' });
        // The session stays active behind the overlay, so it travels with it —
        // dropping it here would lose the pane this window returns to.
        windowBridge.setView(get().activeWorkspaceId, {
          activeSessionId: get().activeSessionId,
          overlay: 'inbox',
        });
      },

      openAutomations: () => {
        set({ overlay: 'automations' });
        windowBridge.setView(get().activeWorkspaceId, {
          activeSessionId: get().activeSessionId,
          overlay: 'automations',
        });
      },
    }),
    {
      name: 'consola-navigation',
      storage: createJSONStorage(() => localStorage),
      // Identity is deliberately absent: it belongs to the window, not the app.
      partialize: (state) => ({
        isSidebarHidden: state.isSidebarHidden,
        sidebarWidth: state.sidebarWidth,
        isExplorerVisible: state.isExplorerVisible,
        isWorkItemPanelVisible: state.isWorkItemPanelVisible,
      }),
      // partialize only governs writes. zustand's default merge spreads the
      // *raw* persisted blob over fresh state on every hydrate, so a profile
      // written before this task would still overwrite the window-context-seeded
      // identity with whatever workspace that blob last held. mergeNavigationState
      // takes only the preference keys, and only when they're the right type.
      merge: (persisted, current) => mergeNavigationState(persisted, current as NavigationState),
    }
  )
);

/**
 * The Automations side panel names a run or an automation of the workspace it
 * was opened in, so the window moving to another workspace closes it.
 * Selecting the workspace it already shows leaves it open. A notification
 * opens its panel without switching (`subscribeToShowAutomations`), so it is
 * never closed by this.
 */
export function closePanelOnWorkspaceSwitch(previous: string | null, next: string | null): void {
  if (previous !== next) useAutomationsStore.getState().closePanel();
}

/** React to main dropping this window's workspace, e.g. after a delete. */
export function subscribeToWindowWorkspace(): () => void {
  return windowBridge.onWorkspaceChanged((workspaceId) => {
    closePanelOnWorkspaceSwitch(useNavigationStore.getState().activeWorkspaceId, workspaceId);
    useNavigationStore.setState({
      activeWorkspaceId: workspaceId,
      activeSessionId: null,
      overlay: null,
    });
  });
}

/**
 * React to main pointing this window at a session — an OS notification click.
 * Main already wrote the session into the workspace's view memory, so only the
 * store moves here; echoing it back would be a loop.
 *
 * The Inbox closes with it, the same way it does for every other route into a
 * session: a window showing the Inbox would otherwise swallow the click and
 * leave the notification looking broken.
 */
export function subscribeToActivateSession(): () => void {
  return windowBridge.onActivateSession((sessionId) => {
    useNavigationStore.setState({ activeSessionId: sessionId, overlay: null });
  });
}

/**
 * React to main opening Automations — a notification click about a run. Main
 * already wrote the overlay into the workspace's view memory, so only the
 * store moves here. The session stays active behind the overlay, as it does
 * for the Inbox, and the run the notice names opens in the side panel.
 */
export function subscribeToShowAutomations(): () => void {
  return windowBridge.onShowAutomations(({ runId }) => {
    useNavigationStore.setState({ overlay: 'automations' });
    if (runId) useAutomationsStore.getState().openPanel({ kind: 'run', runId });
  });
}
