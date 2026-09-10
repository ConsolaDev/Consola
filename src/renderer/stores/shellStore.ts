import { create } from 'zustand';

/** View preferences only; processes and scrollback live in main. */
export const useShellStore = create<{
  open: Record<string, boolean>;
  toggle(instanceId: string): void;
  remove(instanceId: string): void;
}>(set => ({
  open: {},
  toggle: id => set(state => ({ open: { ...state.open, [id]: !state.open[id] } })),
  remove: id => set(state => {
    const open = { ...state.open };
    delete open[id];
    return { open };
  }),
}));
