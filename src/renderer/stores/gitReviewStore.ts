import { create } from 'zustand';
import { gitBridge } from '../services/gitBridge';
import { useGitStatusStore } from './gitStatusStore';

type ViewMode = 'diff' | 'file';

interface GitReviewState {
  // Panel visibility
  isOpen: boolean;

  // Sidebar collapsed state
  isSidebarCollapsed: boolean;

  // Which file sections are expanded in the diff list
  expandedFiles: Set<string>;

  // Per-file view mode toggle (diff vs full file)
  viewMode: Map<string, ViewMode>;

  // Commit message input
  commitMessage: string;

  // Loading states
  isGeneratingMessage: boolean;
  isCommitting: boolean;

  // Why the last generate or commit failed, if it did
  error: string | null;

  // File to scroll to (set by sidebar click, cleared after scroll)
  scrollToFile: string | null;

  // Actions
  open: () => void;
  close: () => void;
  toggle: () => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleFileExpanded: (filePath: string) => void;
  setFileExpanded: (filePath: string, expanded: boolean) => void;
  expandFiles: (filePaths: string[]) => void;
  collapseAllFiles: () => void;
  getViewMode: (filePath: string) => ViewMode;
  setViewMode: (filePath: string, mode: ViewMode) => void;
  toggleViewMode: (filePath: string) => void;
  setCommitMessage: (message: string) => void;
  setGeneratingMessage: (loading: boolean) => void;
  setCommitting: (loading: boolean) => void;
  setError: (error: string | null) => void;
  /** Draft a message for the staged changes with the headless CLI. */
  generateCommitMessage: (rootPath: string) => Promise<void>;
  /** Commit the staged changes using the current message. */
  commitStaged: (rootPath: string) => Promise<void>;
  setScrollToFile: (filePath: string | null) => void;
  reset: () => void;
}

export const useGitReviewStore = create<GitReviewState>((set, get) => ({
  isOpen: false,
  isSidebarCollapsed: false,
  expandedFiles: new Set(),
  viewMode: new Map(),
  commitMessage: '',
  isGeneratingMessage: false,
  isCommitting: false,
  error: null,
  scrollToFile: null,

  open: () => set({ isOpen: true }),

  close: () => set({ isOpen: false }),

  toggle: () => set((state) => ({ isOpen: !state.isOpen })),

  toggleSidebar: () => set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),

  setSidebarCollapsed: (collapsed) => set({ isSidebarCollapsed: collapsed }),

  toggleFileExpanded: (filePath) => {
    const { expandedFiles } = get();
    const newExpanded = new Set(expandedFiles);
    if (newExpanded.has(filePath)) {
      newExpanded.delete(filePath);
    } else {
      newExpanded.add(filePath);
    }
    set({ expandedFiles: newExpanded });
  },

  setFileExpanded: (filePath, expanded) => {
    const { expandedFiles } = get();
    const newExpanded = new Set(expandedFiles);
    if (expanded) {
      newExpanded.add(filePath);
    } else {
      newExpanded.delete(filePath);
    }
    set({ expandedFiles: newExpanded });
  },

  expandFiles: (filePaths) => {
    const { expandedFiles } = get();
    const newExpanded = new Set(expandedFiles);
    for (const path of filePaths) {
      newExpanded.add(path);
    }
    set({ expandedFiles: newExpanded });
  },

  collapseAllFiles: () => set({ expandedFiles: new Set() }),

  getViewMode: (filePath) => {
    const { viewMode } = get();
    return viewMode.get(filePath) ?? 'diff';
  },

  setViewMode: (filePath, mode) => {
    const { viewMode } = get();
    const newViewMode = new Map(viewMode);
    newViewMode.set(filePath, mode);
    set({ viewMode: newViewMode });
  },

  toggleViewMode: (filePath) => {
    const { viewMode } = get();
    const currentMode = viewMode.get(filePath) ?? 'diff';
    const newMode = currentMode === 'diff' ? 'file' : 'diff';
    const newViewMode = new Map(viewMode);
    newViewMode.set(filePath, newMode);
    set({ viewMode: newViewMode });
  },

  setCommitMessage: (message) => set({ commitMessage: message }),

  setGeneratingMessage: (loading) => set({ isGeneratingMessage: loading }),

  setCommitting: (loading) => set({ isCommitting: loading }),

  setError: (error) => set({ error }),

  // Generating and committing live in the store rather than in the commit bar
  // so the command palette can trigger them too, and so both entry points
  // share one in-flight flag and one error message.
  generateCommitMessage: async (rootPath) => {
    set({ isGeneratingMessage: true, error: null });
    try {
      const result = await gitBridge.generateCommitMessage(rootPath);
      if (result?.message) {
        set({ commitMessage: result.message });
      } else if (result?.error) {
        set({ error: result.error });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to generate message' });
    } finally {
      set({ isGeneratingMessage: false });
    }
  },

  commitStaged: async (rootPath) => {
    const message = get().commitMessage.trim();
    if (!message) return;

    set({ isCommitting: true, error: null });
    try {
      const result = await gitBridge.commit(rootPath, message);
      if (result?.success) {
        set({ commitMessage: '' });
        await useGitStatusStore.getState().refresh(rootPath);
      } else if (result?.error) {
        set({ error: result.error });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to commit' });
    } finally {
      set({ isCommitting: false });
    }
  },

  setScrollToFile: (filePath) => set({ scrollToFile: filePath }),

  reset: () => set({
    isOpen: false,
    isSidebarCollapsed: false,
    expandedFiles: new Set(),
    viewMode: new Map(),
    commitMessage: '',
    isGeneratingMessage: false,
    isCommitting: false,
    error: null,
    scrollToFile: null,
  }),
}));
