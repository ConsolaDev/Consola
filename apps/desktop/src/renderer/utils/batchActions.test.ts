import { describe, expect, it, vi } from 'vitest';
import type { SettleBatchResult } from '../../shared/preferences';
import { settleBatchMessage } from './batchActions';

vi.mock('./sessionActions', () => ({ deleteSessionCompletely: vi.fn() }));
vi.mock('../services/attentionBridge', () => ({ attentionBridge: {} }));

const result = (applied: string[], removed?: string[], refused = 0): SettleBatchResult => ({
  applied,
  refused: Array.from({ length: refused }, (_, index) => ({
    sessionId: `r${index}`,
    reason: 'in-use',
    message: 'It is still in use.',
  })),
  memento: {},
  ...(removed ? { removed } : {}),
});

describe('settleBatchMessage', () => {
  it('reads as any batch when nothing was removed', () => {
    expect(settleBatchMessage(result(['a', 'b']), 2)).toBe('Settled 2 sessions.');
    expect(settleBatchMessage(result(['a'], [], 1), 2)).toBe(
      'Settled 1 of 2 sessions. 1 could not be settled.',
    );
  });

  it('counts apart what never had a message and was removed', () => {
    expect(settleBatchMessage(result(['a', 'b', 'c'], ['c']), 3)).toBe(
      'Settled 3 sessions. 1 never had a message, so it was removed.',
    );
    expect(settleBatchMessage(result(['a', 'b', 'c'], ['b', 'c'], 1), 4)).toBe(
      'Settled 3 of 4 sessions. 1 could not be settled. 2 never had a message, so they were removed.',
    );
  });

  it('says only "removed" when everything asked for was removed', () => {
    expect(settleBatchMessage(result(['a'], ['a']), 1)).toBe(
      'Removed 1 session: it never had a message.',
    );
    expect(settleBatchMessage(result(['a', 'b'], ['a', 'b']), 2)).toBe(
      'Removed 2 sessions: they never had a message.',
    );
  });
});
