import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_HISTORY_PER_WORKSPACE,
  MAX_TABS_PER_SESSION,
  type BrowserStateFile,
} from '../../shared/browser';
import {
  BrowserStateStore,
  MAX_STORED_ADDRESS_CHARS,
  storableAddress,
  WRITE_DEBOUNCE_MS,
  normalizeBrowserState,
  normalizeSessionBrowser,
} from './BrowserStateStore';

/** A web address of exactly `length` characters. */
const addressOf = (length: number, origin = 'https://long.example.com') =>
  `${origin}/${'p'.repeat(length - origin.length - 1)}`;

describe('storableAddress', () => {
  it('keeps an address up to the cap as it is', () => {
    const address = addressOf(MAX_STORED_ADDRESS_CHARS);
    expect(address).toHaveLength(MAX_STORED_ADDRESS_CHARS);
    expect(storableAddress(address)).toBe(address);
    expect(storableAddress('')).toBe('');
  });

  it('keeps only the origin of a longer one', () => {
    expect(storableAddress(addressOf(MAX_STORED_ADDRESS_CHARS + 1))).toBe(
      'https://long.example.com/',
    );
    expect(storableAddress(addressOf(MAX_STORED_ADDRESS_CHARS * 4, 'http://127.0.0.1:3000'))).toBe(
      'http://127.0.0.1:3000/',
    );
  });

  it('keeps nothing of a longer one that has no origin to keep', () => {
    expect(storableAddress(`not an address ${'x'.repeat(MAX_STORED_ADDRESS_CHARS)}`)).toBe('');
  });
});

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

  it('repairs a tab stored with an address past the cap to its origin', () => {
    const long = addressOf(MAX_STORED_ADDRESS_CHARS + 50);
    const s = normalizeSessionBrowser({ tabs: [tab('a', { url: long })], activeTabId: 'a' });
    expect(s?.tabs[0].url).toBe('https://long.example.com/');
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

  it('drops a stored visit whose address is past the cap', () => {
    const state = normalizeBrowserState({
      sessions: {},
      history: {
        w: [
          { url: addressOf(MAX_STORED_ADDRESS_CHARS + 1), title: 'long', at: 2 },
          { url: 'https://a.com/', title: 'a', at: 1 },
        ],
      },
    });
    expect(state.history.w).toEqual([{ url: 'https://a.com/', title: 'a', at: 1 }]);
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

  it('skips a visit whose address is past the cap', () => {
    store.addHistory('w', { url: 'https://a.com/', title: 'a', at: 1 });
    store.addHistory('w', { url: addressOf(MAX_STORED_ADDRESS_CHARS + 1), title: 'long', at: 2 });
    expect(store.getHistory('w')).toEqual([{ url: 'https://a.com/', title: 'a', at: 1 }]);
  });

  it('keeps a tab’s long address in memory, and writes only its origin', () => {
    const long = addressOf(MAX_STORED_ADDRESS_CHARS + 1);
    store.setSession('s1', {
      tabs: [{ ...tab('a'), url: long, openedBy: 'person' }],
      activeTabId: 'a',
    });
    expect(store.getSession('s1')?.tabs[0].url).toBe(long);
    store.flush();
    expect(writes.at(-1)?.sessions.s1.tabs[0].url).toBe('https://long.example.com/');
    // What it wrote reads back as it was written.
    stored = writes.at(-1);
    store.load();
    expect(store.getSession('s1')?.tabs[0].url).toBe('https://long.example.com/');
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
