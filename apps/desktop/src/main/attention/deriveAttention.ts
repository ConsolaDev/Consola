import type { Attention, AttentionRecord } from '../../shared/attention';
import type { TerminalStatus } from '../../shared/terminalStatus';

export interface AttentionInputs {
  terminal: TerminalStatus;
  record: AttentionRecord | undefined;
  /** Always false until Task 2b wires it. Not yet consulted by the decision order. */
  isViewedInFocusedWindow: boolean;
  /** Always false until slice 6. Not yet consulted by the decision order. */
  heldByOpenRun: boolean;
}

/**
 * The one place a session's attention is decided. Pure and main-only: the
 * renderer reads the result and never derives it, so two processes cannot
 * disagree about what a session is.
 */
export function deriveAttention({ terminal, record }: AttentionInputs): Attention {
  const settled = record?.settledAt !== undefined && record.settledAt >= record.lastActiveAt;
  if (settled && (terminal === 'ready' || terminal === 'exited')) return 'settled';

  switch (terminal) {
    case 'exited':
      return 'exited';
    case 'needs-attention':
      return 'needs-attention';
    case 'working':
      return 'working';
    case 'ready': {
      const finished = record?.finishedAt;
      const unseen = finished !== undefined && (record?.seenAt === undefined || record.seenAt < finished);
      return unseen ? 'done' : 'ready';
    }
    default: {
      const unhandled: never = terminal;
      throw new Error(`Unhandled terminal status: ${String(unhandled)}`);
    }
  }
}
