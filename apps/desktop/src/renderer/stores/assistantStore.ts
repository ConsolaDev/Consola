import { create } from 'zustand';
import type { AssistantActivitySnapshot } from '../../shared/types';
import { assistantBridge } from '../services/assistantBridge';
import { nextTrayState, sameTrayState, type TrayState } from '../utils/assistantTray';

interface AssistantState {
  /** What the Assistant touched and what finished unseen, per workspace. */
  activity: Record<string, AssistantActivitySnapshot>;
  /** Its approval tray, per workspace. In memory only: a restart shows what waits. */
  tray: Record<string, TrayState>;
  load: (workspaceId: string) => Promise<void>;
  subscribe: () => () => void;
  /** Fold in the requests waiting now: a new one reopens a hidden tray. */
  reconcileTray: (workspaceId: string, waitingIds: string[]) => void;
  setTrayHidden: (workspaceId: string, hidden: boolean) => void;
}

export const useAssistantStore = create<AssistantState>((set) => ({
  activity: {},
  tray: {},
  load: async (workspaceId) => {
    const activity = await assistantBridge.getActivity(workspaceId);
    set((state) => ({ activity: { ...state.activity, [workspaceId]: activity } }));
  },
  subscribe: () =>
    assistantBridge.onActivityChanged(({ workspaceId, activity }) =>
      set((state) => ({ activity: { ...state.activity, [workspaceId]: activity } }))
    ),
  reconcileTray: (workspaceId, waitingIds) =>
    set((state) => {
      const next = nextTrayState(state.tray[workspaceId], waitingIds);
      return sameTrayState(state.tray[workspaceId], next) ? state : { tray: { ...state.tray, [workspaceId]: next } };
    }),
  setTrayHidden: (workspaceId, hidden) =>
    set((state) => ({
      tray: { ...state.tray, [workspaceId]: { known: state.tray[workspaceId]?.known ?? [], hidden } },
    })),
}));
