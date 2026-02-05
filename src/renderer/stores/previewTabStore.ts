import { create } from 'zustand';

export interface PreviewTab {
  id: string;        // File path serves as unique ID
  filePath: string;
  filename: string;
}

interface PreviewTabState {
  tabs: PreviewTab[];
  activeTabId: string | null;

  openFile: (filePath: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  closeAllTabs: () => void;
  closeOtherTabs: (tabId: string) => void;
  closeTabsToRight: (tabId: string) => void;
}

function getFilename(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

export const usePreviewTabStore = create<PreviewTabState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openFile: (filePath: string) => {
    const { tabs } = get();
    const existingTab = tabs.find((t) => t.filePath === filePath);

    if (existingTab) {
      // File already open, just focus it
      set({ activeTabId: existingTab.id });
      return;
    }

    // Create new tab
    const newTab: PreviewTab = {
      id: filePath,
      filePath,
      filename: getFilename(filePath),
    };

    set({
      tabs: [...tabs, newTab],
      activeTabId: newTab.id,
    });
  },

  closeTab: (tabId: string) => {
    const { tabs, activeTabId } = get();
    const tabIndex = tabs.findIndex((t) => t.id === tabId);
    if (tabIndex === -1) return;

    const newTabs = tabs.filter((t) => t.id !== tabId);

    // Determine new active tab
    let newActiveTabId: string | null = activeTabId;
    if (activeTabId === tabId) {
      if (newTabs.length === 0) {
        newActiveTabId = null;
      } else if (tabIndex > 0) {
        newActiveTabId = newTabs[tabIndex - 1].id;
      } else {
        newActiveTabId = newTabs[0].id;
      }
    }

    set({
      tabs: newTabs,
      activeTabId: newActiveTabId,
    });
  },

  setActiveTab: (tabId: string) => {
    const { tabs } = get();
    if (tabs.some((t) => t.id === tabId)) {
      set({ activeTabId: tabId });
    }
  },

  closeAllTabs: () => {
    set({ tabs: [], activeTabId: null });
  },

  closeOtherTabs: (tabId: string) => {
    const { tabs } = get();
    const tabToKeep = tabs.find((t) => t.id === tabId);
    if (!tabToKeep) return;

    set({
      tabs: [tabToKeep],
      activeTabId: tabId,
    });
  },

  closeTabsToRight: (tabId: string) => {
    const { tabs, activeTabId } = get();
    const tabIndex = tabs.findIndex((t) => t.id === tabId);
    if (tabIndex === -1) return;

    const newTabs = tabs.slice(0, tabIndex + 1);

    // If active tab was to the right, set clicked tab as active
    const activeIndex = tabs.findIndex((t) => t.id === activeTabId);
    const newActiveTabId = activeIndex > tabIndex ? tabId : activeTabId;

    set({
      tabs: newTabs,
      activeTabId: newActiveTabId,
    });
  },
}));
