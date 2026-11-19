import { create } from 'zustand';

/** What the custom snooze dialog acts on: one session or a selection, and the names its toast uses. */
export interface SnoozeDialogTarget {
  workspaceId: string;
  sessionIds: string[];
  /** Session id to the name a toast says. */
  names: Record<string, string>;
}

interface SnoozeDialogState {
  target: SnoozeDialogTarget | null;
  open: (target: SnoozeDialogTarget) => void;
  close: () => void;
}

/**
 * A store rather than props, like the link dialog's: Custom… is offered from
 * a row's menu, a selection's menu and the usage-limit strip, and the dialog
 * must outlive a menu that closes as it opens it.
 */
export const useSnoozeDialogStore = create<SnoozeDialogState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
