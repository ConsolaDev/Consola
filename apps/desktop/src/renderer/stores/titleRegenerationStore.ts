import { create } from 'zustand';
import { workspaceBridge } from '../services/workspaceBridge';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { showToast } from './toastStore';

interface TitleRegenerationState {
  /** Sessions whose title is being rewritten right now. */
  running: Record<string, true>;
}

export const useTitleRegenerationStore = create<TitleRegenerationState>(() => ({ running: {} }));

/**
 * Ask main to write a session's title again. A second ask while one is in
 * flight is ignored, so a double click cannot start two model calls. Failure
 * is shown to the person: they asked for this, so silence would read as a
 * title that simply did not change.
 */
export async function regenerateTitle(workspaceId: string, sessionId: string): Promise<void> {
  if (useTitleRegenerationStore.getState().running[sessionId]) return;
  useTitleRegenerationStore.setState((state) => ({
    running: { ...state.running, [sessionId]: true },
  }));
  try {
    await workspaceBridge.regenerateSessionTitle(workspaceId, sessionId);
  } catch (error) {
    showToast(`Couldn’t regenerate the title: ${ipcErrorMessage(error)}`);
  } finally {
    useTitleRegenerationStore.setState((state) => {
      const { [sessionId]: _done, ...rest } = state.running;
      return { running: rest };
    });
  }
}
