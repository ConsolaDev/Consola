import { create } from 'zustand';
import type {
  Attention,
  AttentionChange,
  AttentionSnapshot,
  AttentionState,
  SnoozeView,
} from '../../shared/attention';
import { attentionBridge } from '../services/attentionBridge';

interface AttentionStoreState {
  /** Recorded activity by session id. A session with no entry has none yet. */
  records: AttentionSnapshot;
  /** What main derived for each session, by session id. Read here, never computed. */
  attention: AttentionState['attention'];
  /** Each session's snooze, as main derived it: the countdown, or the Woke mark. */
  snoozes: AttentionState['snoozes'];
}

export const useAttentionStore = create<AttentionStoreState>(() => ({
  records: {},
  attention: {},
  snoozes: {},
}));

/** One session's snooze view, if it has one. Selects a single value, so a row re-renders only for its own change. */
export function useSessionSnooze(sessionId: string | undefined): SnoozeView | undefined {
  return useAttentionStore((state) => (sessionId ? state.snoozes[sessionId] : undefined));
}

/** A session main has said nothing about is `ready`: it has asked for nothing. */
export function attentionOf(attention: AttentionState['attention'], sessionId: string): Attention {
  return attention[sessionId] ?? 'ready';
}

/** One session's attention. Selects a single value, so a row re-renders only for its own change. */
export function useSessionAttention(sessionId: string | undefined): Attention {
  return useAttentionStore((state) =>
    sessionId ? attentionOf(state.attention, sessionId) : 'ready',
  );
}

/** Apply a delta, leaving every entry it does not name as it was. */
export function applyAttentionChange(change: AttentionChange): void {
  useAttentionStore.setState((state) => {
    const attention = { ...state.attention, ...change.changed };
    for (const key of change.removed) delete attention[key];
    if (!change.snoozes) return { attention };
    const snoozes = { ...state.snoozes };
    for (const [key, view] of Object.entries(change.snoozes)) {
      if (view === null) delete snoozes[key];
      else snoozes[key] = view;
    }
    return { attention, snoozes };
  });
}

/**
 * Read main's state once at startup.
 *
 * A change that arrived before this answer was sent is older than the answer,
 * so the answer replaces everything; one sent after it arrives after it and
 * is applied on top. Subscribe before calling this, so none is missed.
 */
export async function hydrateAttention(): Promise<void> {
  const { records, attention, snoozes } = await attentionBridge.getSnapshot();
  useAttentionStore.setState({ records, attention, snoozes: snoozes ?? {} });
}

/** Apply main's pushed changes. Returns the unsubscribe. */
export function subscribeToAttention(): () => void {
  return attentionBridge.onChanged(applyAttentionChange);
}
