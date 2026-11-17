import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attention, AttentionChange } from '../../shared/attention';
import type { AttentionSource } from './AttentionSource';
import { AttentionService, BROADCAST_MS } from './AttentionService';

function fakeSource(initial: Record<string, Attention>, holds?: Record<string, string[]>) {
  let entries = new Map(Object.entries(initial));
  const subscribers = new Set<() => void>();
  const source: AttentionSource = {
    kind: 'fake',
    read: () => new Map(entries),
    holds: holds ? () => new Map(Object.entries(holds)) : undefined,
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
  };
  return {
    source,
    set(next: Record<string, Attention>) {
      entries = new Map(Object.entries(next));
      subscribers.forEach((cb) => cb());
    },
    subscribers,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('AttentionService', () => {
  it('merges what every registered source reads', () => {
    const service = new AttentionService();
    service.register(fakeSource({ a: 'working' }).source);
    service.register(fakeSource({ 'run:1': 'needs-attention' }).source);
    expect(service.get('a')).toBe('working');
    expect(service.snapshot().get('run:1')).toBe('needs-attention');
  });

  it('counts needs-attention only: done never earns a badge', () => {
    const service = new AttentionService();
    service.register(
      fakeSource({ a: 'needs-attention', b: 'done', c: 'working', d: 'needs-attention' }).source,
    );
    expect(service.needsAttentionCount()).toBe(2);
  });

  it('coalesces a burst into one broadcast of only what changed', () => {
    const service = new AttentionService();
    const fake = fakeSource({ a: 'ready', b: 'ready' });
    service.register(fake.source);
    service.flush(); // the initial full state

    const changes: AttentionChange[] = [];
    service.onChange((change) => changes.push(change));
    fake.set({ a: 'working', b: 'ready' });
    fake.set({ a: 'done', b: 'ready' });
    fake.set({ a: 'needs-attention', b: 'ready' });
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(BROADCAST_MS);
    expect(changes).toEqual([{ changed: { a: 'needs-attention' }, removed: [] }]);
  });

  it('reports a vanished entry as removed, and stays quiet when nothing changed', () => {
    const service = new AttentionService();
    const fake = fakeSource({ a: 'ready', b: 'ready' });
    service.register(fake.source);
    service.flush();
    const changes: AttentionChange[] = [];
    service.onChange((change) => changes.push(change));

    fake.set({ a: 'ready', b: 'ready' });
    vi.advanceTimersByTime(BROADCAST_MS);
    expect(changes).toEqual([]);

    fake.set({ a: 'ready' });
    vi.advanceTimersByTime(BROADCAST_MS);
    expect(changes).toEqual([{ changed: {}, removed: ['b'] }]);
  });

  it('answers a read at once, ahead of the broadcast', () => {
    const service = new AttentionService();
    const fake = fakeSource({ a: 'ready' });
    service.register(fake.source);
    fake.set({ a: 'needs-attention' });
    expect(service.needsAttentionCount()).toBe(1);
  });

  it('gathers holds from the sources that declare them', () => {
    const service = new AttentionService();
    service.register(fakeSource({}, { s1: ['run:1'] }).source);
    service.register(fakeSource({}).source);
    expect(service.holds()).toEqual(new Map([['s1', ['run:1']]]));
  });

  it('stops listening to a source once it is unregistered', () => {
    const service = new AttentionService();
    const fake = fakeSource({ a: 'ready' });
    const off = service.register(fake.source);
    off();
    expect(fake.subscribers.size).toBe(0);
    expect(service.snapshot().size).toBe(0);
  });

  it('keeps notifying when one listener throws', () => {
    const service = new AttentionService();
    const fake = fakeSource({ a: 'ready' });
    service.register(fake.source);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const heard = vi.fn();
    service.onChange(() => {
      throw new Error('boom');
    });
    service.onChange(heard);
    service.flush();
    expect(heard).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });
});
