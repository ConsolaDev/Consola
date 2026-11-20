import { create } from 'zustand';

interface RenamingState {
  /** The session whose sidebar row has its rename field open in this window. */
  sessionId: string | null;
}

/**
 * Which row is being renamed, so the sidebar keeps that row where it is
 * until the field closes (`pinHold`). The field itself stays the row's own.
 */
export const useRenamingStore = create<RenamingState>(() => ({ sessionId: null }));

/**
 * Marks a session's row as being renamed. Returns the call that unmarks it,
 * which leaves alone a mark another row has made since.
 */
export function markRenaming(sessionId: string): () => void {
  useRenamingStore.setState({ sessionId });
  return () => {
    if (useRenamingStore.getState().sessionId === sessionId) {
      useRenamingStore.setState({ sessionId: null });
    }
  };
}
