import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContents } from 'electron';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { MAX_TABS_PER_SESSION, type BrowserSessionSnapshot } from '../../shared/browser';
import { IPC_CHANNELS } from '../../shared/constants';
import { BrowserService, CRASH_RETRY_LIMIT, CRASH_RETRY_WINDOW_MS } from './BrowserService';
import { BrowserStateStore } from './BrowserStateStore';

class FakeGuest extends EventEmitter {
  destroyed = false;
  title = '';
  back = false;
  forward = false;
  loading = false;
  url = '';
  loadURL = vi.fn(async (_url: string) => {});
  reload = vi.fn();
  stop = vi.fn();
  close = vi.fn(() => {
    this.destroyed = true;
  });
  goBack = vi.fn();
  goForward = vi.fn();
  navigationHistory = {
    canGoBack: () => this.back,
    canGoForward: () => this.forward,
    goBack: this.goBack,
    goForward: this.goForward,
  };
  constructor(public readonly id: number) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isLoading() {
    return this.loading;
  }
  getURL() {
    return this.url;
  }
  getTitle() {
    return this.title;
  }
  asWebContents() {
    return this as unknown as WebContents;
  }
}

interface Sent {
  window: string;
  channel: string;
  payload: { sessionId: string; snapshot: BrowserSessionSnapshot };
}

let store: BrowserStateStore;
let sent: Sent[];
let now: number;
let ids: number;
let clearPartition: Mock<(workspaceId: string) => void>;
let service: BrowserService;

const winA = { name: 'A' } as unknown as BrowserWindow;
const winB = { name: 'B' } as unknown as BrowserWindow;
const sessionWorkspace: Record<string, string> = { s1: 'w1', s2: 'w1', s3: 'w2' };

beforeEach(() => {
  store = new BrowserStateStore({ read: () => null, write: () => {} });
  sent = [];
  now = 1_000_000;
  ids = 0;
  clearPartition = vi.fn<(workspaceId: string) => void>();
  service = new BrowserService({
    store,
    workspaceIdForSession: (id) => sessionWorkspace[id],
    findWindowForWorkspace: (w) => (w === 'w1' ? winA : w === 'w2' ? winB : undefined),
    send: (window, channel, payload) =>
      sent.push({ window: (window as unknown as { name: string }).name, channel, payload }),
    clearPartition,
    now: () => now,
    newId: () => `tab${++ids}`,
  });
});

/** A let-go page is stopped and blanked, never `close()`d (that leaves it running). */
function blanked(guest: FakeGuest) {
  expect(guest.close).not.toHaveBeenCalled();
  expect(guest.stop).toHaveBeenCalled();
  expect(guest.loadURL).toHaveBeenCalledWith('about:blank');
}
function left(guest: FakeGuest) {
  expect(guest.stop).not.toHaveBeenCalled();
  expect(guest.loadURL).not.toHaveBeenCalled();
}

const last = () => sent[sent.length - 1];

describe('tabs', () => {
  it('opens a tab, activates it and snapshots to the workspace window only', () => {
    const tab = service.openTab('s1', 'https://example.com/', 'person');
    expect(tab).toMatchObject({ id: 'tab1', url: 'https://example.com/', openedBy: 'person' });
    expect(service.snapshotFor('s1').activeTabId).toBe('tab1');
    expect(sent).toHaveLength(1);
    expect(last().window).toBe('A');
    expect(last().channel).toBe(IPC_CHANNELS.BROWSER_SNAPSHOT);
    expect(last().payload.sessionId).toBe('s1');
    expect(last().payload.snapshot.tabs[0]).toMatchObject({
      id: 'tab1',
      live: false,
      loading: false,
      agentActive: false,
    });
  });

  it('does not push when no window holds the workspace', () => {
    service = new BrowserService({
      store,
      workspaceIdForSession: (id) => sessionWorkspace[id],
      findWindowForWorkspace: () => undefined,
      send: (_w, c, p) => sent.push({ window: '?', channel: c, payload: p as never }),
      clearPartition,
    });
    service.openTab('s1', 'https://example.com/', 'person');
    expect(sent).toHaveLength(0);
  });

  it('respects the tab cap', () => {
    for (let i = 0; i < MAX_TABS_PER_SESSION; i++) {
      expect(service.openTab('s1', `https://e.com/${i}`, 'agent')).not.toBeNull();
    }
    expect(service.openTab('s1', 'https://e.com/extra', 'person')).toBeNull();
    expect(service.listFor('s1')).toHaveLength(MAX_TABS_PER_SESSION);
  });

  it('refuses a session unknown to any workspace and non-web addresses', () => {
    expect(service.openTab('nope', 'https://e.com', 'person')).toBeNull();
    expect(service.openTab('s1', 'file:///etc/passwd', 'person')).toBeNull();
    expect(service.openTab('s1', 'javascript:alert(1)', 'person')).toBeNull();
  });

  it('opens an empty tab for the address bar to fill', () => {
    expect(service.openTab('s1', '', 'person')?.url).toBe('');
  });

  it('closes a tab, moves the active one to a neighbour and destroys its guest', () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.openTab('s1', 'https://b.com', 'person');
    service.openTab('s1', 'https://c.com', 'person');
    const guest = new FakeGuest(11);
    service.bindGuest('tab3', guest.asWebContents(), winA);
    service.closeTab('tab3');
    blanked(guest);
    expect(service.snapshotFor('s1').activeTabId).toBe('tab2');
    service.closeTab('tab1');
    expect(service.snapshotFor('s1').activeTabId).toBe('tab2');
    service.closeTab('tab2');
    expect(service.snapshotFor('s1')).toEqual({ tabs: [], activeTabId: null });
  });

  it('activates only a tab that exists', () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.openTab('s1', 'https://b.com', 'person');
    service.activateTab('tab1');
    expect(service.snapshotFor('s1').activeTabId).toBe('tab1');
    service.activateTab('ghost');
    expect(service.snapshotFor('s1').activeTabId).toBe('tab1');
  });

  it('reports ownership by workspace', () => {
    service.openTab('s1', 'https://a.com', 'person');
    expect(service.tabBelongsToWorkspace('tab1', 'w1')).toBe(true);
    expect(service.tabBelongsToWorkspace('tab1', 'w2')).toBe(false);
    expect(service.tabBelongsToWorkspace('ghost', 'w1')).toBe(false);
  });
});

describe('navigate and commit', () => {
  it('refuses file: and loads a web address on the bound guest', () => {
    service.openTab('s1', 'https://a.com', 'person');
    const guest = new FakeGuest(11);
    service.bindGuest('tab1', guest.asWebContents(), winA);
    expect(service.navigate('tab1', 'file:///etc/passwd')).toBe(false);
    expect(guest.loadURL).not.toHaveBeenCalled();
    expect(service.navigate('tab1', 'https://b.com/')).toBe(true);
    expect(guest.loadURL).toHaveBeenCalledWith('https://b.com/');
  });

  it('records the address of an unbound tab for the next mount', () => {
    service.openTab('s1', '', 'person');
    expect(service.navigate('tab1', 'https://b.com/')).toBe(true);
    expect(service.listFor('s1')[0].url).toBe('https://b.com/');
  });

  it('a commit updates url, title and history, and skips a non-web url in history', () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.recordCommit('tab1', 'https://b.com/', 'B');
    expect(service.listFor('s1')[0]).toMatchObject({ url: 'https://b.com/', title: 'B' });
    expect(store.getHistory('w1')).toEqual([{ url: 'https://b.com/', title: 'B', at: now }]);
    service.recordCommit('tab1', 'about:blank', '');
    expect(store.getHistory('w1')).toHaveLength(1);
  });

  it('guest events drive url, title, loading, back/forward and errors', () => {
    service.openTab('s1', 'https://a.com', 'person');
    const guest = new FakeGuest(11);
    service.bindGuest('tab1', guest.asWebContents(), winA);
    expect(last().payload.snapshot.tabs[0].live).toBe(true);

    guest.emit('did-start-loading');
    expect(last().payload.snapshot.tabs[0].loading).toBe(true);

    guest.title = 'Page';
    guest.back = true;
    guest.emit('did-navigate', {}, 'https://a.com/next');
    expect(last().payload.snapshot.tabs[0]).toMatchObject({
      url: 'https://a.com/next',
      title: 'Page',
      canGoBack: true,
    });

    guest.emit('page-title-updated', {}, 'Renamed');
    expect(service.listFor('s1')[0].title).toBe('Renamed');

    guest.emit('did-navigate-in-page', {}, 'https://a.com/next#x', true);
    expect(service.listFor('s1')[0].url).toBe('https://a.com/next#x');
    guest.emit('did-navigate-in-page', {}, 'https://a.com/frame', false);
    expect(service.listFor('s1')[0].url).toBe('https://a.com/next#x');

    guest.emit('did-stop-loading');
    expect(last().payload.snapshot.tabs[0].loading).toBe(false);
  });

  it('ignores an aborted load and subframe failures, and records an unreachable page', () => {
    service.openTab('s1', 'https://a.com', 'person');
    const guest = new FakeGuest(11);
    service.bindGuest('tab1', guest.asWebContents(), winA);
    guest.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://a.com', true);
    guest.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x.com', false);
    expect(last().payload.snapshot.tabs[0].error ?? null).toBeNull();
    guest.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x.com', true);
    expect(last().payload.snapshot.tabs[0].error).toEqual({
      kind: 'unreachable',
      code: -105,
      description: 'ERR_NAME_NOT_RESOLVED',
      url: 'https://x.com',
    });
    // A fresh navigation clears it.
    guest.emit('did-start-loading');
    expect(last().payload.snapshot.tabs[0].error ?? null).toBeNull();
  });

  it('a failed load keeps its error and is not a visit when its error page commits', () => {
    service.openTab('s1', 'https://a.com', 'person');
    const guest = new FakeGuest(11);
    service.bindGuest('tab1', guest.asWebContents(), winA);
    guest.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x.com/', true);
    guest.emit('did-navigate', {}, 'https://x.com/');
    guest.emit('did-navigate', {}, 'chrome-error://chromewebdata/');
    expect(last().payload.snapshot.tabs[0].error).toMatchObject({ kind: 'unreachable' });
    expect(service.listFor('s1')[0].url).toBe('https://a.com');
    expect(store.getHistory('w1')).toEqual([]);
  });

  it('back, forward, reload and stop act on the guest', () => {
    service.openTab('s1', 'https://a.com', 'person');
    const guest = new FakeGuest(11);
    service.bindGuest('tab1', guest.asWebContents(), winA);
    guest.back = true;
    guest.forward = true;
    service.goBack('tab1');
    service.goForward('tab1');
    service.reload('tab1');
    service.stop('tab1');
    expect(guest.goBack).toHaveBeenCalled();
    expect(guest.goForward).toHaveBeenCalled();
    expect(guest.reload).toHaveBeenCalled();
    expect(guest.stop).toHaveBeenCalled();
    guest.back = false;
    service.goBack('tab1');
    expect(guest.goBack).toHaveBeenCalledTimes(1);
  });
});

describe('crashes', () => {
  it('reloads at most 3 times in 30 s, then leaves the crash for the person', () => {
    service.openTab('s1', 'https://a.com', 'person');
    const guest = new FakeGuest(11);
    service.bindGuest('tab1', guest.asWebContents(), winA);
    for (let i = 0; i < CRASH_RETRY_LIMIT; i++) {
      guest.emit('render-process-gone', {}, { reason: 'crashed' });
      now += 1000;
    }
    expect(guest.reload).toHaveBeenCalledTimes(CRASH_RETRY_LIMIT);
    guest.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(guest.reload).toHaveBeenCalledTimes(CRASH_RETRY_LIMIT);
    expect(last().payload.snapshot.tabs[0].error).toEqual({ kind: 'crashed' });
  });

  it('forgets crashes older than the window', () => {
    service.openTab('s1', 'https://a.com', 'person');
    const guest = new FakeGuest(11);
    service.bindGuest('tab1', guest.asWebContents(), winA);
    for (let i = 0; i < CRASH_RETRY_LIMIT; i++) guest.emit('render-process-gone', {}, {});
    now += CRASH_RETRY_WINDOW_MS + 1;
    guest.emit('render-process-gone', {}, {});
    expect(guest.reload).toHaveBeenCalledTimes(CRASH_RETRY_LIMIT + 1);
  });

  it('does not reload a clean exit', () => {
    service.openTab('s1', 'https://a.com', 'person');
    const guest = new FakeGuest(11);
    service.bindGuest('tab1', guest.asWebContents(), winA);
    guest.emit('render-process-gone', {}, { reason: 'clean-exit' });
    expect(guest.reload).not.toHaveBeenCalled();
  });
});

describe('guests', () => {
  it('unbinds when the guest is destroyed, keeping the tab', () => {
    service.openTab('s1', 'https://a.com', 'person');
    const guest = new FakeGuest(11);
    service.bindGuest('tab1', guest.asWebContents(), winA);
    guest.destroyed = true;
    guest.emit('destroyed');
    expect(service.listFor('s1')).toHaveLength(1);
    expect(service.snapshotFor('s1').tabs[0].live).toBe(false);
    expect(guest.listenerCount('did-navigate')).toBe(0);
    expect(service.guestFor('tab1')).toBeUndefined();
  });

  it('binding a second guest to a tab replaces the first without closing it', () => {
    service.openTab('s1', 'https://a.com', 'person');
    const first = new FakeGuest(11);
    const second = new FakeGuest(12);
    service.bindGuest('tab1', first.asWebContents(), winA);
    service.bindGuest('tab1', second.asWebContents(), winA);
    expect(first.listenerCount('did-navigate')).toBe(0);
    left(first);
    expect(service.guestFor('tab1')?.id).toBe(12);
  });

  it('refuses to bind a tab that does not exist', () => {
    const guest = new FakeGuest(11);
    expect(service.bindGuest('ghost', guest.asWebContents(), winA)).toBe(false);
    expect(guest.listenerCount('did-navigate')).toBe(0);
  });

  it("detachWindow forgets that window's guests and keeps tabs", () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.openTab('s3', 'https://b.com', 'person');
    const ga = new FakeGuest(11);
    const gb = new FakeGuest(12);
    service.bindGuest('tab1', ga.asWebContents(), winA);
    service.bindGuest('tab2', gb.asWebContents(), winB);
    service.detachWindow(winA);
    expect(service.guestFor('tab1')).toBeUndefined();
    expect(service.guestFor('tab2')).toBeDefined();
    expect(service.listFor('s1')).toHaveLength(1);
    left(ga);
  });
});

describe('closing windows', () => {
  it('sends nothing to a destroyed window and does not throw', () => {
    const dead = { name: 'A', isDestroyed: () => true } as unknown as BrowserWindow;
    service = new BrowserService({
      store,
      workspaceIdForSession: (id) => sessionWorkspace[id],
      findWindowForWorkspace: () => dead,
      send: (_w, c, p) => sent.push({ window: 'dead', channel: c, payload: p as never }),
      clearPartition,
    });
    expect(() => service.openTab('s1', 'https://a.com', 'person')).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it('detachWindow pushes no snapshot', () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.bindGuest('tab1', new FakeGuest(11).asWebContents(), winA);
    sent.length = 0;
    service.detachWindow(winA);
    expect(sent).toHaveLength(0);
    expect(service.snapshotFor('s1').tabs[0].live).toBe(false);
  });
});

describe('lifecycle', () => {
  it('destroySession drops tabs and destroys guests', () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.openTab('s2', 'https://b.com', 'person');
    const guest = new FakeGuest(11);
    service.bindGuest('tab1', guest.asWebContents(), winA);
    service.destroySession('s1');
    blanked(guest);
    expect(service.listFor('s1')).toEqual([]);
    expect(service.listFor('s2')).toHaveLength(1);
  });

  it('destroyWorkspace drops every session of the workspace, its history, and clears the partition', () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.openTab('s2', 'https://b.com', 'person');
    service.openTab('s3', 'https://c.com', 'person');
    service.recordCommit('tab1', 'https://a.com/x', 'x');
    const guest = new FakeGuest(11);
    service.bindGuest('tab2', guest.asWebContents(), winA);
    service.destroyWorkspace('w1', ['s1', 's2']);
    blanked(guest);
    expect(service.listFor('s1')).toEqual([]);
    expect(service.listFor('s2')).toEqual([]);
    expect(service.listFor('s3')).toHaveLength(1);
    expect(store.getHistory('w1')).toEqual([]);
    expect(clearPartition).toHaveBeenCalledWith('w1');
  });

  describe('a page that was loading before it was bound', () => {
    const attach = (guest: FakeGuest) => service.noteAttached(guest.asWebContents(), guest.id);

    it('a load that failed before bind shows as unreachable after bind', () => {
      service.openTab('s1', 'https://a.com', 'person');
      const guest = new FakeGuest(11);
      attach(guest);
      guest.emit('did-start-loading');
      guest.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://a.com/', true);
      guest.emit('did-stop-loading');
      service.bindGuest('tab1', guest.asWebContents(), winA);
      const tab = service.snapshotFor('s1').tabs[0];
      expect(tab.error).toMatchObject({ kind: 'unreachable', code: -105 });
      expect(tab.loading).toBe(false);
    });

    it('a guest still loading at bind shows loading', () => {
      service.openTab('s1', 'https://a.com', 'person');
      const guest = new FakeGuest(11);
      attach(guest);
      guest.emit('did-start-loading');
      guest.loading = true;
      service.bindGuest('tab1', guest.asWebContents(), winA);
      expect(service.snapshotFor('s1').tabs[0].loading).toBe(true);
    });

    it('a redirect before bind records the final address', () => {
      service.openTab('s1', 'https://a.com', 'person');
      const guest = new FakeGuest(11);
      attach(guest);
      guest.emit('did-navigate', {}, 'https://a.com/final');
      service.bindGuest('tab1', guest.asWebContents(), winA);
      expect(service.snapshotFor('s1').tabs[0].url).toBe('https://a.com/final');
    });

    it('reads the guest address at bind when nothing was buffered', () => {
      service.openTab('s1', '', 'person');
      const guest = new FakeGuest(11);
      guest.url = 'https://a.com/now';
      service.bindGuest('tab1', guest.asWebContents(), winA);
      expect(service.snapshotFor('s1').tabs[0].url).toBe('https://a.com/now');
    });

    it('a failure the page then recovered from is not an error', () => {
      service.openTab('s1', 'https://a.com', 'person');
      const guest = new FakeGuest(11);
      attach(guest);
      guest.emit('did-fail-load', {}, -105, 'x', 'https://a.com/', true);
      guest.emit('did-start-loading');
      service.bindGuest('tab1', guest.asWebContents(), winA);
      expect(service.snapshotFor('s1').tabs[0].error).toBeFalsy();
    });

    it('drops the buffer when the guest is destroyed or goes unclaimed', () => {
      vi.useFakeTimers();
      try {
        const gone = new FakeGuest(11);
        attach(gone);
        gone.emit('destroyed');
        expect(gone.listenerCount('did-fail-load')).toBe(0);
        const idle = new FakeGuest(12);
        attach(idle);
        vi.advanceTimersByTime(30_001);
        expect(idle.listenerCount('did-fail-load')).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores a subframe failure and an aborted load', () => {
      service.openTab('s1', 'https://a.com', 'person');
      const guest = new FakeGuest(11);
      attach(guest);
      guest.emit('did-fail-load', {}, -105, 'x', 'https://ads.com/', false);
      guest.emit('did-fail-load', {}, -3, 'aborted', 'https://a.com/', true);
      service.bindGuest('tab1', guest.asWebContents(), winA);
      expect(service.snapshotFor('s1').tabs[0].error).toBeFalsy();
    });
  });

  describe('when the store has already forgotten the sessions', () => {
    const liveCount = () => (service as unknown as { live: Map<string, unknown> }).live.size;

    function openTwoGuests() {
      service.openTab('s1', 'https://a.com', 'person');
      service.openTab('s2', 'https://b.com', 'person');
      const g1 = new FakeGuest(11);
      const g2 = new FakeGuest(12);
      service.bindGuest('tab1', g1.asWebContents(), winA);
      service.bindGuest('tab2', g2.asWebContents(), winA);
      return { g1, g2 };
    }

    it('destroyWorkspace still closes the guests, before the partition is cleared', () => {
      const { g1, g2 } = openTwoGuests();
      // What workspaces.onChange does while the delete is still under way.
      store.prune(new Set(['s3']), new Set(['w2']));
      service.destroyWorkspace('w1', ['s1', 's2']);
      blanked(g1);
      blanked(g2);
      expect(g1.loadURL.mock.invocationCallOrder[0]).toBeLessThan(
        clearPartition.mock.invocationCallOrder[0],
      );
      expect(liveCount()).toBe(0);
    });

    it('destroyWorkspace closes a guest of a session the caller did not name', () => {
      const { g1 } = openTwoGuests();
      service.destroyWorkspace('w1', []);
      blanked(g1);
    });

    it('destroySession closes guests of a pruned session and drops their live state', () => {
      const { g1, g2 } = openTwoGuests();
      store.prune(new Set(['s2']), new Set(['w1']));
      service.destroySession('s1');
      blanked(g1);
      left(g2);
      expect(liveCount()).toBe(1);
    });

    it('prune closes the guests of sessions that no longer exist, then prunes the store', () => {
      const { g1, g2 } = openTwoGuests();
      service.openTab('s3', 'https://c.com', 'person');
      const kept = new FakeGuest(13);
      service.bindGuest('tab3', kept.asWebContents(), winB);
      service.prune(new Set(['s3']), new Set(['w2']));
      blanked(g1);
      blanked(g2);
      left(kept);
      expect(service.listFor('s1')).toEqual([]);
      expect(service.listFor('s3')).toHaveLength(1);
      expect(liveCount()).toBe(1);
    });

    it('a late destroyed event for a removed tab leaves no live entry behind', () => {
      service.openTab('s1', 'https://a.com', 'person');
      const guest = new FakeGuest(11);
      service.bindGuest('tab1', guest.asWebContents(), winA);
      store.prune(new Set(), new Set());
      guest.emit('destroyed');
      expect(liveCount()).toBe(0);
      expect(service.guestFor('tab1')).toBeUndefined();
    });
  });

  it('destroyAll flushes the store and destroys guests', () => {
    service.openTab('s1', 'https://a.com', 'person');
    const guest = new FakeGuest(11);
    service.bindGuest('tab1', guest.asWebContents(), winA);
    const flush = vi.spyOn(store, 'flush');
    service.destroyAll();
    expect(flush).toHaveBeenCalled();
    blanked(guest);
    expect(service.guestFor('tab1')).toBeUndefined();
  });
});
