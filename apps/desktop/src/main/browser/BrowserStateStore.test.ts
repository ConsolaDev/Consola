import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_HISTORY_PER_WORKSPACE,
  MAX_TABS_PER_SESSION,
  type BrowserStateFile,
} from '../../shared/browser';
import {
  BrowserStateStore,
  WRITE_DEBOUNCE_MS,
  normalizeBrowserState,
  normalizeSessionBrowser,
} from './BrowserStateStore';

const tab = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  url: `https://example.com/${id}`,
  title: id,
  openedBy: 'person',
  ...extra,
});

describe('normalizeSessionBrowser', () => {
  it('rejects wrong types', () => {
    expect(normalizeSessionBrowser(null)).toBeNull();
    expect(normalizeSessionBrowser('x')).toBeNull();
    expect(normalizeSessionBrowser({ tabs: 'x' })).toBeNull();
    expect(normalizeSessionBrowser({ tabs: [] })).toBeNull();
  });

  it('skips malformed and unknown-origin tabs, and duplicate ids', () => {
    const s = normalizeSessionBrowser({
      tabs: [
        tab('a'),
        { id: 3 },
        tab('b', { openedBy: 'robot' }),
        tab('a'),
        tab('c', { title: 1 }),
      ],
      activeTabId: 'a',
    });
    expect(s?.tabs.map((t) => t.id)).toEqual(['a']);
  });

  it('caps the tabs', () => {
    const tabs = Array.from({ length: MAX_TABS_PER_SESSION + 5 }, (_, i) => tab(`t${i}`));
    expect(normalizeSessionBrowser({ tabs, activeTabId: 't0' })?.tabs).toHaveLength(
      MAX_TABS_PER_SESSION,
    );
  });

  it('falls a dangling activeTabId to the first tab', () => {
    expect(
      normalizeSessionBrowser({ tabs: [tab('a'), tab('b')], activeTabId: 'gone' })?.activeTabId,
    ).toBe('a');
    expect(normalizeSessionBrowser({ tabs: [tab('a')], activeTabId: 7 })?.activeTabId).toBe('a');
  });
});

describe('normalizeBrowserState', () => {
  it('survives garbage', () => {
    expect(normalizeBrowserState(undefined)).toEqual({ sessions: {}, history: {} });
    expect(normalizeBrowserState({ sessions: 3, history: [] })).toEqual({
      sessions: {},
      history: {},
    });
  });

  it('keeps good entries beside bad ones and caps history', () => {
    const history = Array.from({ length: MAX_HISTORY_PER_WORKSPACE + 9 }, (_, i) => ({
      url: `https://e.com/${i}`,
      title: 't',
      at: i,
    }));
    const state = normalizeBrowserState({
      sessions: { good: { tabs: [tab('a')], activeTabId: 'a' }, bad: { tabs: 1 } },
      history: {
        w: [...history, { url: 1 }, { url: 'u', title: 't', at: Number.NaN }],
        empty: [{}],
      },
    });
    expect(Object.keys(state.sessions)).toEqual(['good']);
    expect(state.history.w).toHaveLength(MAX_HISTORY_PER_WORKSPACE);
    expect(state.history.empty).toBeUndefined();
  });
});

describe('BrowserStateStore', () => {
  let writes: BrowserStateFile[];
  let stored: unknown;
  let store: BrowserStateStore;

  beforeEach(() => {
    vi.useFakeTimers();
    writes = [];
    stored = null;
    store = new BrowserStateStore({
      read: () => stored,
      write: (v) => writes.push(structuredClone(v)),
    });
    store.load();
  });
  afterEach(() => vi.useRealTimers());

  const session = (id: string) => ({
    tabs: [{ ...tab(id), openedBy: 'person' as const }],
    activeTabId: id,
  });

  it('loads without failing when the file is unreadable', () => {
    const broken = new BrowserStateStore({
      read: () => {
        throw new Error('corrupt');
      },
      write: () => {},
    });
    expect(() => broken.load()).not.toThrow();
    expect(broken.sessionIds()).toEqual([]);
  });

  it('loads normalised state', () => {
    stored = { sessions: { s: { tabs: [tab('a')], activeTabId: 'zzz' } }, history: {} };
    store.load();
    expect(store.getSession('s')?.activeTabId).toBe('a');
  });

  it('debounces writes into one', () => {
    store.setSession('s1', session('a'));
    store.setSession('s2', session('b'));
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(WRITE_DEBOUNCE_MS);
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0].sessions)).toEqual(['s1', 's2']);
  });

  it('flush writes at once and only when something is pending', () => {
    store.flush();
    expect(writes).toHaveLength(0);
    store.setSession('s1', session('a'));
    store.flush();
    expect(writes).toHaveLength(1);
    vi.advanceTimersByTime(WRITE_DEBOUNCE_MS * 2);
    expect(writes).toHaveLength(1);
  });

  it('removes a session left with no tabs', () => {
    store.setSession('s1', session('a'));
    store.setSession('s1', { tabs: [], activeTabId: null });
    expect(store.getSession('s1')).toBeUndefined();
  });

  it('dedupes the latest history entry and caps the list, newest first', () => {
    store.addHistory('w', { url: 'https://a.com', title: 'old', at: 1 });
    store.addHistory('w', { url: 'https://a.com', title: 'new', at: 2 });
    expect(store.getHistory('w')).toEqual([{ url: 'https://a.com', title: 'new', at: 2 }]);
    store.addHistory('w', { url: 'https://b.com', title: 'b', at: 3 });
    store.addHistory('w', { url: 'https://a.com', title: 'a', at: 4 });
    expect(store.getHistory('w').map((e) => e.url)).toEqual([
      'https://a.com',
      'https://b.com',
      'https://a.com',
    ]);
    for (let i = 0; i < MAX_HISTORY_PER_WORKSPACE + 10; i++) {
      store.addHistory('w', { url: `https://e.com/${i}`, title: '', at: i });
    }
    expect(store.getHistory('w')).toHaveLength(MAX_HISTORY_PER_WORKSPACE);
    expect(store.getHistory('w')[0].url).toBe(`https://e.com/${MAX_HISTORY_PER_WORKSPACE + 9}`);
  });

  it('prunes sessions and workspaces that are gone', () => {
    store.setSession('keep', session('a'));
    store.setSession('drop', session('b'));
    store.addHistory('w1', { url: 'https://a.com', title: '', at: 1 });
    store.addHistory('w2', { url: 'https://a.com', title: '', at: 1 });
    store.prune(new Set(['keep']), new Set(['w1']));
    expect(store.sessionIds()).toEqual(['keep']);
    expect(store.getHistory('w2')).toEqual([]);
    expect(store.getHistory('w1')).toHaveLength(1);
  });
});
