import { create } from 'zustand';

/** Whether this window has focus. Written by `useViewingReport`, read by rows that mask round-trip latency. */
export const useWindowFocusStore = create<{ focused: boolean }>(() => ({ focused: true }));
