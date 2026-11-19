import { describe, expect, it } from 'vitest';
import type {
  BrowserSessionSnapshot,
  BrowserTabError,
  BrowserTabSnapshot,
} from '../../../shared/browser';
import {
  addressText,
  autoRetryUrl,
  hostOrder,
  liveTabs,
  nextShownError,
  pagePresence,
  RETRY_MAX_MS,
  retryDelayMs,
  tabLabel,
  visibleTabId,
} from './browserView';

function tab(id: string, fields: Partial<BrowserTabSnapshot> = {}): BrowserTabSnapshot {
  return {
    id,
    url: `https://example.com/${id}`,
    title: '',
    openedBy: 'person',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    live: false,
    agentActive: false,
    ...fields,
  };
}

function snapshot(tabs: BrowserTabSnapshot[], activeTabId: string | null): BrowserSessionSnapshot {
  return { tabs, activeTabId };
}

const unreachable = (url: string): BrowserTabError => ({
  kind: 'unreachable',
  code: -102,
  description: 'ERR_CONNECTION_REFUSED',
  url,
});

describe('liveTabs', () => {
  const snapshots = {
    a: snapshot([tab('a1'), tab('a2')], 'a2'),
    b: snapshot([tab('b1')], 'b1'),
    c: snapshot([tab('c1')], null),
  };

  it('keeps the active tab of each shown session of this workspace, and only that tab', () => {
    const live = liveTabs(['a', 'b'], new Set(['a', 'b']), snapshots);
    expect(live.map((hosted) => [hosted.sessionId, hosted.tab.id])).toEqual([
      ['a', 'a2'],
      ['b', 'b1'],
    ]);
  });

  it('leaves out a session never shown, one of another workspace, and one with no active tab', () => {
    expect(liveTabs(['a'], new Set(['a', 'b']), snapshots).map((h) => h.tab.id)).toEqual(['a2']);
    expect(liveTabs(['a', 'b'], new Set(['b']), snapshots).map((h) => h.tab.id)).toEqual(['b1']);
    expect(liveTabs(['c'], new Set(['c']), snapshots)).toEqual([]);
  });

  it('leaves out a shown session whose tabs are not known yet', () => {
    expect(liveTabs(['unknown'], new Set(['unknown']), snapshots)).toEqual([]);
  });
});

describe('hostOrder', () => {
  it('appends new pages and drops gone ones without reordering the rest', () => {
    expect(hostOrder(['x', 'y', 'z'], ['z', 'w', 'x'])).toEqual(['x', 'z', 'w']);
  });

  it('keeps a page where it is even when the live list names it first', () => {
    expect(hostOrder(['x', 'y'], ['y', 'x'])).toEqual(['x', 'y']);
  });

  it('returns the previous order itself when nothing changed', () => {
    const previous = ['x', 'y'];
    expect(hostOrder(previous, ['y', 'x'])).toBe(previous);
  });

  it('starts from nothing', () => {
    expect(hostOrder([], ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('visibleTabId', () => {
  const snapshots = { a: snapshot([tab('a1'), tab('a2')], 'a2') };

  it('is the active tab of the session whose panel is on screen', () => {
    expect(visibleTabId('a', snapshots)).toBe('a2');
  });

  it('is nothing when no panel is on screen or its session has no tab', () => {
    expect(visibleTabId(null, snapshots)).toBeNull();
    expect(visibleTabId('b', snapshots)).toBeNull();
    expect(visibleTabId('a', { a: snapshot([tab('a1')], null) })).toBeNull();
  });
});

describe('pagePresence', () => {
  it('shows the visible tab', () => {
    expect(pagePresence('t', 't', false)).toBe('shown');
    expect(pagePresence('t', 't', true)).toBe('shown');
  });

  it('keeps painting a hidden page that must, and takes every other hidden page off screen', () => {
    expect(pagePresence('t', 'other', true)).toBe('painting');
    expect(pagePresence('t', null, true)).toBe('painting');
    expect(pagePresence('t', 'other', false)).toBe('hidden');
    expect(pagePresence('t', null, false)).toBe('hidden');
  });
});

describe('nextShownError', () => {
  const failed = unreachable('http://localhost:3000/');

  it('shows the error main reports', () => {
    expect(nextShownError(null, { loading: false, error: failed })).toBe(failed);
  });

  it('keeps showing the last error while a new load is under way', () => {
    expect(nextShownError(failed, { loading: true, error: null })).toBe(failed);
    expect(nextShownError(failed, { loading: true })).toBe(failed);
  });

  it('clears once a load ends without one', () => {
    expect(nextShownError(failed, { loading: false, error: null })).toBeNull();
    expect(nextShownError(null, { loading: true })).toBeNull();
  });

  it('takes a newer error over the held one', () => {
    const crashed: BrowserTabError = { kind: 'crashed' };
    expect(nextShownError(failed, { loading: false, error: crashed })).toBe(crashed);
  });
});

describe('retryDelayMs', () => {
  it('doubles from one second and stops at ten', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(retryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000,
    ]);
    expect(RETRY_MAX_MS).toBe(10_000);
  });
});

describe('autoRetryUrl', () => {
  it('retries an unreachable page on this machine', () => {
    expect(autoRetryUrl(unreachable('http://localhost:5173/'))).toBe('http://localhost:5173/');
    expect(autoRetryUrl(unreachable('http://127.0.0.1:8080/app'))).toBe(
      'http://127.0.0.1:8080/app',
    );
  });

  it('leaves remote pages, other errors and no error alone', () => {
    expect(autoRetryUrl(unreachable('https://example.com/'))).toBeNull();
    expect(autoRetryUrl(unreachable('not a url'))).toBeNull();
    expect(autoRetryUrl({ kind: 'crashed' })).toBeNull();
    expect(
      autoRetryUrl({
        kind: 'certificate',
        url: 'https://localhost/',
        host: 'localhost',
        error: 'x',
      }),
    ).toBeNull();
    expect(autoRetryUrl(null)).toBeNull();
  });
});

describe('addressText', () => {
  it("shows the tab's address", () => {
    expect(addressText(tab('t', { url: 'https://example.com/a' }), null)).toBe(
      'https://example.com/a',
    );
  });

  it('shows the address that failed rather than the last page that loaded', () => {
    const failed = unreachable('http://localhost:3000/');
    expect(addressText(tab('t', { url: 'https://example.com/' }), failed)).toBe(
      'http://localhost:3000/',
    );
  });

  it('is empty for no tab and for a blank one', () => {
    expect(addressText(undefined, null)).toBe('');
    expect(addressText(tab('t', { url: '' }), null)).toBe('');
    expect(addressText(tab('t', { url: 'about:blank' }), null)).toBe('');
    expect(addressText(tab('t', { url: '' }), { kind: 'crashed' })).toBe('');
  });
});

describe('tabLabel', () => {
  it('prefers the page title', () => {
    expect(tabLabel(tab('t', { title: ' Docs ', url: 'https://a.test/x' }))).toBe('Docs');
  });

  it('falls back to the host, port included', () => {
    expect(tabLabel(tab('t', { title: '', url: 'http://127.0.0.1:3000/a' }))).toBe(
      '127.0.0.1:3000',
    );
  });

  it('calls a tab that has been nowhere a new tab', () => {
    expect(tabLabel(tab('t', { title: '', url: '' }))).toBe('New tab');
    expect(tabLabel(tab('t', { title: '', url: 'about:blank' }))).toBe('New tab');
  });
});
