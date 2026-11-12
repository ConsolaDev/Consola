import type { SessionStatus } from './sessionStatus';

export type AssistantRowState =
  | { kind: 'disabled' }
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'needs-you' }
  | { kind: 'done'; count: number };

/**
 * What the sidebar's Assistant row shows. The Assistant's own status outranks
 * the sessions it is watching: a question waiting on the person comes first,
 * then work in flight, then "N finished" — which stops being news once the
 * person is looking at the Assistant.
 */
export function assistantRowState(input: {
  hasScopes: boolean;
  status?: SessionStatus;
  unseenFinished: number;
  isActive: boolean;
}): AssistantRowState {
  if (!input.hasScopes) return { kind: 'disabled' };
  if (input.status === 'needs-attention') return { kind: 'needs-you' };
  if (input.status === 'working') return { kind: 'working' };
  if (input.unseenFinished > 0 && !input.isActive) return { kind: 'done', count: input.unseenFinished };
  return { kind: 'idle' };
}
