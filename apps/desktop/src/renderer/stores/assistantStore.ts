import { create } from 'zustand';
import type { AssistantActivitySnapshot } from '../../shared/types';
import { assistantBridge } from '../services/assistantBridge';

interface AssistantState {
  /** What the Assistant touched and what finished unseen, per workspace. */
  activity: Record<string, AssistantActivitySnapshot>;
  load: (workspaceId: string) => Promise<void>;
  subscribe: () => () => void;
}

export const useAssistantStore = create<AssistantState>((set) => ({
  activity: {},
  load: async (workspaceId) => {
    const activity = await assistantBridge.getActivity(workspaceId);
    set((state) => ({ activity: { ...state.activity, [workspaceId]: activity } }));
  },
  subscribe: () =>
    assistantBridge.onActivityChanged(({ workspaceId, activity }) =>
      set((state) => ({ activity: { ...state.activity, [workspaceId]: activity } }))
    ),
}));
