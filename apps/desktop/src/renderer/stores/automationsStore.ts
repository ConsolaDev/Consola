import { create } from 'zustand';
import type { AutomationsSnapshot } from '../../shared/automations';
import { automationsBridge } from '../services/automationsBridge';

interface AutomationsState {
  /** Each workspace's automations and runs, as main last broadcast them. */
  snapshots: Record<string, AutomationsSnapshot>;
  load: (workspaceId: string) => Promise<void>;
  subscribe: () => () => void;
}

/**
 * Workspace automation snapshots for views other than the Automations panel
 * — the Assistant's tray and its sidebar row — kept current from main's push
 * channel, which carries every workspace's changes.
 */
export const useAutomationsStore = create<AutomationsState>((set) => ({
  snapshots: {},
  load: async (workspaceId) => {
    const snapshot = await automationsBridge.getSnapshot(workspaceId);
    if (!snapshot) return;
    set((state) => ({ snapshots: { ...state.snapshots, [workspaceId]: snapshot } }));
  },
  subscribe: () =>
    automationsBridge.onChanged(({ workspaceId, snapshot }) =>
      set((state) => ({ snapshots: { ...state.snapshots, [workspaceId]: snapshot } }))
    ),
}));
