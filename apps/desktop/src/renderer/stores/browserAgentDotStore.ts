import { create } from 'zustand';
import type { BrowserSessionSnapshot } from '../../shared/browser';
import { useBrowserSlotStore } from './browserSlotStore';

/**
 * The dot on a session's globe button: an agent opened or used one of the
 * session's tabs while the browser panel was not showing that session. An
 * agent never opens the panel itself, since nothing it does may change what
 * the person is looking at, so this is how the person learns there is
 * something to look at. It goes out when the panel shows the session.
 *
 * Per window and never persisted, like the snapshots it is read from.
 */
interface BrowserAgentDotState {
  /** Sessions with a dot. */
  dots: Record<string, true>;
}

export const useBrowserAgentDotStore = create<BrowserAgentDotState>(() => ({ dots: {} }));

/**
 * Whether `next` shows an agent doing something `previous` did not: a tab an
 * agent opened that was not there, or a tab whose call has just started (a
 * read, an act, or a move, which marks even the person's own tab). A
 * session the window held nothing for reads as having had no tabs, so an
 * agent's tab opened while the window was elsewhere still counts.
 */
export function agentNews(
  previous: BrowserSessionSnapshot | undefined,
  next: BrowserSessionSnapshot,
): boolean {
  const before = new Map(previous?.tabs.map((tab) => [tab.id, tab]));
  return next.tabs.some((tab) => {
    const was = before.get(tab.id);
    if (!was) return tab.openedBy === 'agent' || tab.agentActive;
    return tab.agentActive && !was.agentActive;
  });
}

/** The dot after a push: lit by news, kept until the panel shows the session, never lit there. */
export function nextAgentDot(input: {
  dot: boolean;
  shown: boolean;
  previous: BrowserSessionSnapshot | undefined;
  next: BrowserSessionSnapshot;
}): boolean {
  if (input.shown) return false;
  return input.dot || agentNews(input.previous, input.next);
}

/** Main pushed `next` for a session the window last knew as `previous`. */
export function noteBrowserPush(
  sessionId: string,
  previous: BrowserSessionSnapshot | undefined,
  next: BrowserSessionSnapshot,
): void {
  const shown = useBrowserSlotStore.getState().sessionId === sessionId;
  useBrowserAgentDotStore.setState((state) => {
    const dot = state.dots[sessionId] === true;
    const lit = nextAgentDot({ dot, shown, previous, next });
    if (lit === dot) return state;
    return { dots: withDot(state.dots, sessionId, lit) };
  });
}

/** The panel shows this session: the person has seen what there was. */
export function clearAgentDot(sessionId: string): void {
  useBrowserAgentDotStore.setState((state) =>
    state.dots[sessionId] ? { dots: withDot(state.dots, sessionId, false) } : state,
  );
}

export function useBrowserAgentDot(sessionId: string): boolean {
  return useBrowserAgentDotStore((state) => state.dots[sessionId] === true);
}

function withDot(
  dots: Record<string, true>,
  sessionId: string,
  lit: boolean,
): Record<string, true> {
  const next = { ...dots };
  if (lit) next[sessionId] = true;
  else delete next[sessionId];
  return next;
}
