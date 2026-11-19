import { create } from 'zustand';
import type {
  BrowserSessionSnapshot,
  BrowserSnapshotMessage,
  BrowserTabSnapshot,
} from '../../shared/browser';
import { browserBridge } from '../services/browserBridge';

interface BrowserStoreState {
  /** What main last said about each session's tabs, by session id. */
  snapshots: Record<string, BrowserSessionSnapshot>;
  /**
   * How many pushes each session has received. A fetch started before a push
   * is older than it, so `load` compares this to know it was overtaken.
   * Forgetting a session counts as one too: an answer still in flight for it
   * must not bring it back.
   */
  pushes: Record<string, number>;
}

export const useBrowserStore = create<BrowserStoreState>(() => ({
  snapshots: {},
  pushes: {},
}));

/** Stable, so a selector for an unknown session does not re-render on every store change. */
export const NO_BROWSER: BrowserSessionSnapshot = { tabs: [], activeTabId: null };

/** The tab showing in a session, if any. */
export function activeTabOf(snapshot: BrowserSessionSnapshot): BrowserTabSnapshot | undefined {
  return snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);
}

/** One session's snapshot; an empty one until main has said anything. */
export function useBrowserSnapshot(sessionId: string | undefined): BrowserSessionSnapshot {
  return useBrowserStore((state) => (sessionId && state.snapshots[sessionId]) || NO_BROWSER);
}

/** One session's active tab. */
export function useActiveBrowserTab(sessionId: string | undefined): BrowserTabSnapshot | undefined {
  const snapshot = useBrowserSnapshot(sessionId);
  return activeTabOf(snapshot);
}

/** Apply a pushed snapshot: it replaces that session's, and no other. */
export function applyBrowserSnapshot(message: BrowserSnapshotMessage): void {
  useBrowserStore.setState((state) => ({
    snapshots: { ...state.snapshots, [message.sessionId]: message.snapshot },
    pushes: { ...state.pushes, [message.sessionId]: (state.pushes[message.sessionId] ?? 0) + 1 },
  }));
}

/**
 * Read a session's snapshot once, for the first paint. An answer that a push
 * overtook while it was in flight is dropped: the push is newer.
 */
export async function loadBrowser(sessionId: string): Promise<void> {
  const before = useBrowserStore.getState().pushes[sessionId] ?? 0;
  const snapshot = await browserBridge.get(sessionId);
  useBrowserStore.setState((state) => {
    if ((state.pushes[sessionId] ?? 0) !== before) return state;
    return { snapshots: { ...state.snapshots, [sessionId]: snapshot } };
  });
}

/**
 * Drop what is held for a session the window no longer shows, and any answer
 * still in flight for it. Main pushes a session's changes only to the window
 * holding its workspace, so what was held would be out of date by the time
 * the window came back to it.
 */
export function forgetBrowser(sessionId: string): void {
  useBrowserStore.setState((state) => {
    const snapshots = { ...state.snapshots };
    delete snapshots[sessionId];
    return {
      snapshots,
      pushes: { ...state.pushes, [sessionId]: (state.pushes[sessionId] ?? 0) + 1 },
    };
  });
}

/** Apply main's pushed snapshots. Returns the unsubscribe. */
export function subscribeToBrowser(): () => void {
  return browserBridge.onSnapshot(applyBrowserSnapshot);
}
