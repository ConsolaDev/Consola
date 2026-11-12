import type { SessionStatus } from './sessionStatus';

export type AssistantRowState =
  | { kind: 'disabled' }
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'needs-you' }
  | { kind: 'waiting'; count: number }
  | { kind: 'done'; count: number };

/**
 * What the sidebar's Assistant row shows. The Assistant's own status outranks
 * the sessions it is watching: a question waiting on the person comes first,
 * then what it asked them to approve — still true while they look at it —
 * then work in flight, then "N finished", which stops being news once the
 * person is looking at the Assistant.
 */
export function assistantRowState(input: {
  hasScopes: boolean;
  status?: SessionStatus;
  unseenFinished: number;
  /** The Assistant's own requests waiting for the person's approval. */
  waitingApprovals: number;
  isActive: boolean;
}): AssistantRowState {
  if (!input.hasScopes) return { kind: 'disabled' };
  if (input.status === 'needs-attention') return { kind: 'needs-you' };
  if (input.waitingApprovals > 0) return { kind: 'waiting', count: input.waitingApprovals };
  if (input.status === 'working') return { kind: 'working' };
  if (input.unseenFinished > 0 && !input.isActive) return { kind: 'done', count: input.unseenFinished };
  return { kind: 'idle' };
}
