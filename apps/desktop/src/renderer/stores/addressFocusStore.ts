import { create } from 'zustand';

/**
 * A request to put the caret in the browser's address bar, for the person's
 * ⌘L. A counter rather than a flag: asking twice must focus twice, and the
 * bar listens for a change, never for a value it would have to reset.
 */
export const useAddressFocusStore = create<{ requests: number }>(() => ({ requests: 0 }));

export function requestAddressFocus(): void {
  useAddressFocusStore.setState((state) => ({ requests: state.requests + 1 }));
}
