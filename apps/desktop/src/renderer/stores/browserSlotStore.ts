import { create } from 'zustand';

/**
 * Where this window's browser panel is. The pages live in a host at the
 * layout's root, never inside the panel (an element that moves loses its
 * page), so the panel says here that its slot is on screen and for which
 * session, and the host shows that session's page over it.
 *
 * Per window and never persisted: a slot exists only while it is mounted.
 */
interface BrowserSlotState {
  /** The session whose browser panel is on screen, if any. */
  sessionId: string | null;
  /** Every session whose panel has been on screen since the window loaded, first shown first. */
  shownSessionIds: string[];
}

export const useBrowserSlotStore = create<BrowserSlotState>(() => ({
  sessionId: null,
  shownSessionIds: [],
}));

/**
 * The panel of `sessionId` is on screen. Returns what to call when it leaves,
 * which clears the slot only if no other panel has taken it since.
 */
export function showBrowserSlot(sessionId: string): () => void {
  useBrowserSlotStore.setState((state) => ({
    sessionId,
    shownSessionIds: state.shownSessionIds.includes(sessionId)
      ? state.shownSessionIds
      : [...state.shownSessionIds, sessionId],
  }));
  return () => {
    useBrowserSlotStore.setState((state) =>
      state.sessionId === sessionId ? { sessionId: null } : state,
    );
  };
}
