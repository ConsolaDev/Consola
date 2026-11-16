import { create } from 'zustand';
import type { AttentionSnapshot } from '../../shared/attention';
import { attentionBridge } from '../services/attentionBridge';

interface AttentionState {
  /** Recorded activity by session id. A session with no entry has none yet. */
  records: AttentionSnapshot;
}

export const useAttentionStore = create<AttentionState>(() => ({ records: {} }));

/** Read main's ledger once at startup. Live updates are a later slice. */
export async function hydrateAttention(): Promise<void> {
  useAttentionStore.setState({ records: await attentionBridge.getSnapshot() });
}
