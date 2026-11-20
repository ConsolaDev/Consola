import { create } from 'zustand';

/**
 * A request to put the keyboard on the browser panel itself, for the moment
 * ⌘W closes the tab the keyboard was in. The page goes with its tab, and the
 * toolbar remounts with the next one, so the keyboard would fall to the
 * document, where a second ⌘W would no longer be the browser's. A counter,
 * like the address bar's request: asking twice must focus twice.
 */
export const useBrowserPanelFocusStore = create<{ requests: number }>(() => ({ requests: 0 }));

export function requestBrowserPanelFocus(): void {
  useBrowserPanelFocusStore.setState((state) => ({ requests: state.requests + 1 }));
}
