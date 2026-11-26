import { create } from 'zustand';

interface NewWorkspaceDialogState {
  /** Bumped by every open, so each one starts a fresh draft. Zero while closed. */
  openedAt: number;
  open: () => void;
  close: () => void;
}

/**
 * Whether this window's "New workspace" dialog is showing. Every door that
 * makes a workspace (the rail's ＋, ⌘N with none open, the palette, the
 * welcome screen) opens this one dialog, so they cannot drift apart.
 */
export const useNewWorkspaceDialogStore = create<NewWorkspaceDialogState>((set, get) => ({
  openedAt: 0,
  // Opening while open keeps the draft the person is in the middle of.
  open: () => {
    if (!get().openedAt) set({ openedAt: Date.now() });
  },
  close: () => set({ openedAt: 0 }),
}));

export function openNewWorkspaceDialog(): void {
  useNewWorkspaceDialogStore.getState().open();
}
