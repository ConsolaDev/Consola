import { describe, expect, it } from 'vitest';
import type {
  BrowserHistoryEntry,
  BrowserSessionSnapshot,
  BrowserTabError,
  BrowserTabSnapshot,
} from '../../../shared/browser';
import {
  addressText,
  autoRetryUrl,
  hostOrder,
  isBlankUrl,
  liveTabs,
  nextShownError,
  pageIsInert,
  pageKey,
  pagePresence,
  recentPages,
  RETRY_MAX_MS,
  retryDelayMs,
  stripScrollToShow,
  stripWheelDelta,
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
    loadId: 0,
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
    a: snapshot([tab('a1', { live: true }), tab('a2'), tab('a3', { live: true })], 'a2'),
    b: snapshot([tab('b1', { live: true })], 'b1'),
    c: snapshot([tab('c1')], null),
  };

  it('keeps every tab main calls live, active or not, and no other', () => {
    const live = liveTabs(new Set(['a', 'b', 'c']), snapshots);
    expect(live.map((hosted) => [hosted.sessionId, hosted.tab.id])).toEqual([
      ['a', 'a1'],
      ['a', 'a3'],
      ['b', 'b1'],
    ]);
  });

  it('leaves out a session of another workspace', () => {
    expect(liveTabs(new Set(['b']), snapshots).map((h) => h.tab.id)).toEqual(['b1']);
    expect(liveTabs(new Set(), snapshots)).toEqual([]);
  });
});

describe('pageKey', () => {
  it('is a new key when a tab is unloaded and shown again, even if never seen not live', () => {
    const before = pageKey(tab('a1', { live: true, loadId: 3 }));
    // Main unloaded and re-showed the tab: live before and after, new load.
    const after = pageKey(tab('a1', { live: true, loadId: 4 }));
    expect(after).not.toBe(before);
    expect(hostOrder([before, 'z:1'], [after, 'z:1'])).toEqual(['z:1', after]);
  });

  it('is stable while the load is the same', () => {
    expect(pageKey(tab('a1', { loadId: 3 }))).toBe(
      pageKey(tab('a1', { loadId: 3, loading: true })),
    );
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

describe('pageIsInert', () => {
  it('makes a page kept painting unseen unreachable to the person, and only that one', () => {
    // Invisible but laid out over the slot (or the whole window): without
    // `inert` it could still be tabbed into, clicked or read aloud.
    expect(pageIsInert('painting')).toBe(true);
    expect(pageIsInert('shown')).toBe(false);
    // Already out of reach: `display: none` takes it out of focus order,
    // hit testing and the accessibility tree.
    expect(pageIsInert('hidden')).toBe(false);
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
        canContinue: true,
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

describe('a blank tab', () => {
  it('is blank with no address or about:blank, and not otherwise', () => {
    expect(isBlankUrl('')).toBe(true);
    expect(isBlankUrl('about:blank')).toBe(true);
    expect(isBlankUrl('http://localhost:3000')).toBe(false);
  });

  it('has no page to host, even when main calls it live', () => {
    const snapshots = {
      a: snapshot(
        [
          tab('blank', { url: '', live: true }),
          tab('about', { url: 'about:blank', live: true }),
          tab('real', { live: true }),
        ],
        'blank',
      ),
    };
    expect(liveTabs(new Set(['a']), snapshots).map((hosted) => hosted.tab.id)).toEqual(['real']);
  });
});

describe('recentPages', () => {
  const entry = (url: string, title = ''): BrowserHistoryEntry => ({ url, title, at: 1 });

  it('keeps each address once, newest first, up to the limit', () => {
    const history = [entry('https://a.com'), entry('https://b.com'), entry('https://a.com')];
    expect(recentPages(history, 2).map((e) => e.url)).toEqual(['https://a.com', 'https://b.com']);
    expect(recentPages(history, 1)).toHaveLength(1);
  });

  it('is empty for no history', () => {
    expect(recentPages([])).toEqual([]);
  });
});

describe('stripScrollToShow', () => {
  const view = { scrollLeft: 100, width: 300 };

  it('leaves the strip where it is when the tab is already in view', () => {
    expect(stripScrollToShow(view, { start: 120, end: 380 })).toBe(100);
    expect(stripScrollToShow(view, { start: 100, end: 400 })).toBe(100);
  });

  it('scrolls back just far enough for a tab cut off on the left', () => {
    expect(stripScrollToShow(view, { start: 40, end: 120 })).toBe(40);
  });

  it('scrolls on just far enough for a tab cut off on the right', () => {
    expect(stripScrollToShow(view, { start: 380, end: 460 })).toBe(160);
  });

  it('shows the start of a tab wider than the strip', () => {
    expect(stripScrollToShow(view, { start: 380, end: 800 })).toBe(380);
  });
});

describe('stripWheelDelta', () => {
  it('turns a vertical wheel into a sideways scroll', () => {
    expect(stripWheelDelta({ deltaX: 0, deltaY: 40, deltaMode: 0 }, 300)).toBe(40);
    expect(stripWheelDelta({ deltaX: 2, deltaY: -40, deltaMode: 0 }, 300)).toBe(-40);
  });

  it('leaves a sideways gesture to the strip’s own scrolling', () => {
    expect(stripWheelDelta({ deltaX: 30, deltaY: 4, deltaMode: 0 }, 300)).toBe(0);
    expect(stripWheelDelta({ deltaX: 0, deltaY: 0, deltaMode: 0 }, 300)).toBe(0);
  });

  it('reads a wheel that counts lines or pages in pixels', () => {
    expect(stripWheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 300)).toBe(48);
    expect(stripWheelDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 300)).toBe(300);
  });
});
