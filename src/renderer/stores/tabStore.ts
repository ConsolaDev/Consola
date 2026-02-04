import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useAgentStore } from './agentStore';

export type TabType = 'home' | 'workspace' | 'project';

export interface Tab {
  id: string;
  type: TabType;
  targetId: string;
  workspaceId?: string;
}

interface TabState {
  tabs: Tab[];
  activeTabId: string;
  openTab: (type: TabType, targetId: string, workspaceId?: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  closeTabsForWorkspace: (workspaceId: string) => void;
  closeTabsForProject: (projectId: string) => void;
}

function generateTabId(type: TabType, targetId: string): string {
  if (type === 'home') return 'home';
  return `${type}-${targetId}`;
}

// Destroy all agent instances matching a context prefix
// Handles current "-main" suffix and future multi-agent instances (e.g., "-agent-2")
function destroyInstancesForContext(contextId: string): void {
  const agentStore = useAgentStore.getState();
  Object.keys(agentStore.instances)
    .filter(id => id.startsWith(contextId))
    .forEach(id => agentStore.destroyInstance(id));
}

const HOME_TAB: Tab = {
  id: 'home',
  type: 'home',
  targetId: '',
};

export const useTabStore = create<TabState>()(
  persist(
    (set, get) => ({
      tabs: [HOME_TAB],
      activeTabId: 'home',

      openTab: (type, targetId, workspaceId) => {
        const tabId = generateTabId(type, targetId);
        const { tabs } = get();

        // If tab already exists, just focus it
        const existingTab = tabs.find((t) => t.id === tabId);
        if (existingTab) {
          set({ activeTabId: tabId });
          return;
        }

        // Create new tab
        const newTab: Tab = {
          id: tabId,
          type,
          targetId,
          workspaceId,
        };

        set({
          tabs: [...tabs, newTab],
          activeTabId: tabId,
        });
      },

      closeTab: (tabId) => {
        // Cannot close home tab
        if (tabId === 'home') return;

        const { tabs, activeTabId } = get();
        const tabIndex = tabs.findIndex((t) => t.id === tabId);
        if (tabIndex === -1) return;

        // Destroy agent instances for this tab's context
        // tabId is the contextId (e.g., "project-abc" or "workspace-xyz")
        destroyInstancesForContext(tabId);

        const newTabs = tabs.filter((t) => t.id !== tabId);

        // If closing the active tab, activate the previous tab or home
        let newActiveTabId = activeTabId;
        if (activeTabId === tabId) {
          if (tabIndex > 0) {
            newActiveTabId = newTabs[tabIndex - 1].id;
          } else {
            newActiveTabId = 'home';
          }
        }

        set({
          tabs: newTabs,
          activeTabId: newActiveTabId,
        });
      },

      setActiveTab: (tabId) => {
        const { tabs } = get();
        if (tabs.some((t) => t.id === tabId)) {
          set({ activeTabId: tabId });
        }
      },

      reorderTabs: (fromIndex, toIndex) => {
        const { tabs } = get();
        if (fromIndex === toIndex) return;
        if (fromIndex < 0 || fromIndex >= tabs.length) return;
        if (toIndex < 0 || toIndex >= tabs.length) return;

        const newTabs = [...tabs];
        const [movedTab] = newTabs.splice(fromIndex, 1);
        newTabs.splice(toIndex, 0, movedTab);

        set({ tabs: newTabs });
      },

      closeTabsForWorkspace: (workspaceId) => {
        const { tabs, activeTabId } = get();
        const tabsToClose = tabs.filter(
          (t) =>
            (t.type === 'workspace' && t.targetId === workspaceId) ||
            (t.type === 'project' && t.workspaceId === workspaceId)
        );

        if (tabsToClose.length === 0) return;

        // Destroy agent instances for all affected tabs
        tabsToClose.forEach((tab) => destroyInstancesForContext(tab.id));

        const newTabs = tabs.filter(
          (t) =>
            !((t.type === 'workspace' && t.targetId === workspaceId) ||
              (t.type === 'project' && t.workspaceId === workspaceId))
        );

        // If active tab was closed, go to home
        const activeWasClosed = tabsToClose.some((t) => t.id === activeTabId);
        set({
          tabs: newTabs,
          activeTabId: activeWasClosed ? 'home' : activeTabId,
        });
      },

      closeTabsForProject: (projectId) => {
        const { tabs, activeTabId } = get();
        const tabId = generateTabId('project', projectId);
        const tabExists = tabs.some((t) => t.id === tabId);

        if (!tabExists) return;

        // Destroy agent instances for this project context
        destroyInstancesForContext(tabId);

        const newTabs = tabs.filter((t) => t.id !== tabId);
        set({
          tabs: newTabs,
          activeTabId: activeTabId === tabId ? 'home' : activeTabId,
        });
      },
    }),
    {
      name: 'console-1-tabs',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
      }),
      // Ensure home tab always exists on load
      onRehydrateStorage: () => (state) => {
        if (state) {
          const hasHome = state.tabs.some((t) => t.id === 'home');
          if (!hasHome) {
            state.tabs = [HOME_TAB, ...state.tabs];
          }
          // Validate activeTabId exists
          const activeExists = state.tabs.some((t) => t.id === state.activeTabId);
          if (!activeExists) {
            state.activeTabId = 'home';
          }
        }
      },
    }
  )
);
