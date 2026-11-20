import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionChange } from '../../shared/attention';

vi.mock('../services/attentionBridge', () => ({
  attentionBridge: {
    getSnapshot: vi.fn(),
    onChanged: vi.fn(() => () => {}),
  },
}));

import { attentionBridge } from '../services/attentionBridge';
import {
  applyAttentionChange,
  attentionOf,
  hydrateAttention,
  subscribeToAttention,
  useAttentionStore,
} from './attentionStore';

const store = () => useAttentionStore.getState();

beforeEach(() => {
  useAttentionStore.setState({ records: {}, attention: {} });
  vi.clearAllMocks();
});

describe('applyAttentionChange', () => {
  it('applies a delta without clobbering entries it does not name', () => {
    useAttentionStore.setState({ attention: { a: 'working', b: 'ready', c: 'done' } });

    applyAttentionChange({ changed: { a: 'needs-attention', d: 'working' }, removed: ['c'] });

    expect(store().attention).toEqual({ a: 'needs-attention', b: 'ready', d: 'working' });
  });

  it('leaves an unchanged entry the same object-level value, so only its own selector moves', () => {
    useAttentionStore.setState({ attention: { a: 'working', b: 'ready' } });
    const seen: string[] = [];
    const unsubscribe = useAttentionStore.subscribe((state, previous) => {
      if (state.attention.b !== previous.attention.b) seen.push('b');
    });

    applyAttentionChange({ changed: { a: 'done' }, removed: [] });
    unsubscribe();

    expect(seen).toEqual([]);
  });
});

describe('attentionOf', () => {
  it('is ready for a session main has said nothing about', () => {
    expect(attentionOf({}, 'x')).toBe('ready');
  });
});

describe('hydrateAttention', () => {
  it('reads derived attention beside the records, so a late window agrees with a long-lived one', async () => {
    vi.mocked(attentionBridge.getSnapshot).mockResolvedValue({
      records: { a: { sessionId: 'a', workspaceId: 'w', lastActiveAt: 1, finishedAt: 5 } },
      attention: { a: 'done' },
      snoozes: {},
    });

    await hydrateAttention();

    expect(store().attention).toEqual({ a: 'done' });
    expect(store().records.a.finishedAt).toBe(5);
  });
});

describe('subscribeToAttention', () => {
  it('routes pushed changes into the store', () => {
    let push: (change: AttentionChange) => void = () => {};
    vi.mocked(attentionBridge.onChanged).mockImplementation((callback) => {
      push = callback;
      return () => {};
    });

    subscribeToAttention();
    push({ changed: { a: 'needs-attention' }, removed: [] });

    expect(store().attention.a).toBe('needs-attention');
  });
});
