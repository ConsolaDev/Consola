import { create } from 'zustand';
import type { InboxItem } from '../../shared/workItems';
import type { Session } from '../../shared/workspace';

/**
 * The two doors into linking. From the Inbox pane the item is known and a
 * session is picked; from the sidebar the session is known and an item is
 * picked. One dialog serves both with the list flipped.
 */
export type LinkSessionDialogMode =
  | { kind: 'pick-session'; workspaceId: string; item: InboxItem }
  | { kind: 'pick-item'; workspaceId: string; session: Session };

interface LinkSessionDialogState {
  mode: LinkSessionDialogMode | null;
  open: (mode: LinkSessionDialogMode) => void;
  close: () => void;
}

/**
 * A store rather than props because the openers live in three unrelated
 * trees (the item pane in the Inbox, the same pane in the side panel's Pull
 * request tab, a sidebar row's menu) and the dialog must outlive all of
 * them — the sidebar unmounts entirely when hidden.
 */
export const useLinkSessionDialogStore = create<LinkSessionDialogState>((set) => ({
  mode: null,
  open: (mode) => set({ mode }),
  close: () => set({ mode: null }),
}));
