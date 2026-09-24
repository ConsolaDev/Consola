import { create } from 'zustand';

export interface NewSessionDestination {
  scopeId?: string;
  groupId?: string;
}

interface NewSessionDialogState {
  destination: (NewSessionDestination & { workspaceId: string; error?: string }) | null;
  open: (workspaceId: string, destination?: NewSessionDestination, error?: string) => void;
  close: () => void;
}

// Window-local and independent of the sidebar, which can be hidden.
export const useNewSessionDialogStore = create<NewSessionDialogState>((set) => ({
  destination: null,
  open: (workspaceId, destination = {}, error) => set({ destination: { workspaceId, ...destination, error } }),
  close: () => set({ destination: null }),
}));
