import { create } from 'zustand';

/**
 * A request to put the caret in the browser's address bar, for the person's
 * own ⌘L, "+" or palette row (an agent's doing never reaches this store).
 * A counter rather than a flag: asking twice must focus twice, and the bar
 * listens for a change, never for a value it would have to reset.
 */
interface AddressFocusState {
  requests: number;
  /**
   * The tab whose bar is asked for, or null for whichever bar is on screen.
   * A tab just opened may not have its bar yet: the request waits for it.
   */
  tabId: string | null;
  /** The last request a bar settled, by taking it or dropping it. */
  settled: number;
}

export const useAddressFocusStore = create<AddressFocusState>(() => ({
  requests: 0,
  tabId: null,
  settled: 0,
}));

export function requestAddressFocus(tabId: string | null = null): void {
  useAddressFocusStore.setState((state) => ({ requests: state.requests + 1, tabId }));
}

/** A bar took the request, or found it was not for it: no bar acts on it again. */
export function settleAddressFocus(): void {
  useAddressFocusStore.setState((state) => ({ settled: state.requests }));
}

/**
 * What the bar of `tabId` does with the latest request, when one is `asked`
 * for while it is on screen, or when it is `shown` (mounted, or its tab
 * changed under it): `take` the caret, `drop` the request, or `leave` it
 * waiting. A request for whichever bar is on screen is that moment's own. One
 * for a tab waits for that tab's bar, but only until the next bar appears: if
 * that is another tab's, the person has moved on, and a bar showing later
 * must not pull the keyboard to itself.
 */
export function addressFocusAnswer(
  state: AddressFocusState,
  tabId: string | null,
  moment: 'asked' | 'shown',
): 'take' | 'drop' | 'leave' {
  if (state.requests === state.settled) return 'leave';
  if (state.tabId === null) return moment === 'asked' ? 'take' : 'drop';
  if (state.tabId === tabId) return 'take';
  return moment === 'shown' ? 'drop' : 'leave';
}
