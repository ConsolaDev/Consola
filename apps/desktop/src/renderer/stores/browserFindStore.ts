import { create } from 'zustand';

/**
 * Whether the browser panel's find bar is open, for the person's ⌘F or the
 * More menu. A store because the chord arrives from outside the panel's tree
 * (`handleBrowserAction`). `requests` is a counter for the same reason as
 * `addressFocusStore`: asking again while open must refocus the field.
 */
export const useBrowserFindStore = create<{ open: boolean; requests: number }>(() => ({
  open: false,
  requests: 0,
}));

export function requestFind(): void {
  useBrowserFindStore.setState((state) => ({ open: true, requests: state.requests + 1 }));
}

export function closeFind(): void {
  useBrowserFindStore.setState({ open: false });
}
