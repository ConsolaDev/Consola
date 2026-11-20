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
  reloadIgnoringCache = vi.fn();
  findInPage = vi.fn();
  stopFindInPage = vi.fn();
  openDevTools = vi.fn();
  zoomLevel = 0;
  setZoomLevel = vi.fn((level: number) => {
    this.zoomLevel = level;
  });
  getZoomLevel() {
    return this.zoomLevel;
  }
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

  it('can open a tab behind the one showing, which it shows only when none is', () => {
    const first = service.openTab('s1', 'https://a.com', 'agent', { keepActiveTab: true });
    expect(service.snapshotFor('s1').activeTabId).toBe(first?.id);
    service.openTab('s1', 'https://b.com', 'person');
    const behind = service.openTab('s1', 'https://c.com', 'agent', { keepActiveTab: true });
    expect(behind).toMatchObject({ id: 'tab3', openedBy: 'agent' });
    expect(service.snapshotFor('s1')).toMatchObject({
      activeTabId: 'tab2',
      tabs: [{ id: 'tab1' }, { id: 'tab2' }, { id: 'tab3' }],
    });
    // Still pushed: the window lists the new tab.
    expect(last().payload.snapshot.tabs.map((tab) => tab.id)).toEqual(['tab1', 'tab2', 'tab3']);
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

  it('names the tab a guest is bound to, and none before or after', () => {
    service.openTab('s1', 'https://a.com', 'person');
    const guest = new FakeGuest(12);
    expect(service.tabIdForGuest(12)).toBeNull();
    service.bindGuest('tab1', guest.asWebContents(), winA);
    expect(service.tabIdForGuest(12)).toBe('tab1');
    service.unbindGuest('tab1');
    expect(service.tabIdForGuest(12)).toBeNull();
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

describe('page tools', () => {
  function bound() {
    service.openTab('s1', 'https://a.com', 'person');
    const guest = new FakeGuest(11);
    service.bindGuest('tab1', guest.asWebContents(), winA);
    return guest;
  }

  it('hard reload ignores the cache', () => {
    const guest = bound();
    service.hardReload('tab1');
    expect(guest.reloadIgnoringCache).toHaveBeenCalled();
    expect(guest.reload).not.toHaveBeenCalled();
  });

  it('finds without moving focus, and continues or reverses a search', () => {
    const guest = bound();
    service.findText('tab1', 'needle', { forward: true, next: false });
    service.findText('tab1', 'needle', { forward: false, next: true });
    expect(guest.findInPage.mock.calls).toEqual([
      ['needle'],
      ['needle', { forward: false, findNext: true }],
    ]);
  });

  it('ignores an empty or non-text search', () => {
    const guest = bound();
    service.findText('tab1', '', { forward: true, next: false });
    service.findText('tab1', 5 as unknown as string, { forward: true, next: false });
    expect(guest.findInPage).not.toHaveBeenCalled();
  });

  it('clears the highlights when a search ends', () => {
    const guest = bound();
    service.stopFind('tab1');
    expect(guest.stopFindInPage).toHaveBeenCalledWith('clearSelection');
  });

  it("tells the window only a search's final result", () => {
    const send = vi.fn();
    const win = { webContents: { send, isDestroyed: () => false } } as unknown as BrowserWindow;
    service.openTab('s1', 'https://a.com', 'person');
    const guest = new FakeGuest(11);
    service.bindGuest('tab1', guest.asWebContents(), win);
    guest.emit('found-in-page', {}, { activeMatchOrdinal: 1, matches: 1, finalUpdate: false });
    expect(send).not.toHaveBeenCalled();
    guest.emit('found-in-page', {}, { activeMatchOrdinal: 2, matches: 5, finalUpdate: true });
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.BROWSER_FOUND, {
      tabId: 'tab1',
      result: { active: 2, total: 5 },
    });
  });

  describe('a search ends', () => {
    function withWindow() {
      const send = vi.fn();
      const win = { webContents: { send, isDestroyed: () => false } } as unknown as BrowserWindow;
      service.openTab('s1', 'https://a.com', 'person');
      const guest = new FakeGuest(11);
      service.bindGuest('tab1', guest.asWebContents(), win);
      return { send, guest };
    }
    const reset = { tabId: 'tab1', result: null };

    it('when the page navigates to another document', () => {
      const { send, guest } = withWindow();
      guest.emit('did-navigate', {}, 'https://a.com/next');
      expect(send).toHaveBeenCalledWith(IPC_CHANNELS.BROWSER_FOUND, reset);
      expect(guest.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    });

    it('but not on a same-document navigation', () => {
      const { send, guest } = withWindow();
      guest.emit('did-navigate-in-page', {}, 'https://a.com/#x', true);
      expect(send).not.toHaveBeenCalled();
    });

    it('when the page is unbound or let go', () => {
      const first = withWindow();
      service.unbindGuest('tab1');
      expect(first.send).toHaveBeenCalledWith(IPC_CHANNELS.BROWSER_FOUND, reset);
    });
  });

  it("steps zoom from the page's own level and reads it back", () => {
    const guest = bound();
    expect(service.zoom('tab1', 'in')).toBe(0.5);
    expect(service.zoom('tab1', 'in')).toBe(1);
    expect(service.zoom('tab1', 'get')).toBe(1);
    expect(guest.setZoomLevel).toHaveBeenCalledTimes(2);
    expect(service.zoom('tab1', 'reset')).toBe(0);
  });

  it('answers the default for a tab with no page', () => {
    service.openTab('s1', 'https://a.com', 'person');
    expect(service.zoom('tab1', 'in')).toBe(0);
  });

  it('opens DevTools detached', () => {
    const guest = bound();
    service.openDevTools('tab1');
    expect(guest.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
  });

  it('gives the latest visit the title that arrives after it', () => {
    const guest = bound();
    guest.emit('did-navigate', {}, 'https://a.com/');
    expect(service.historyFor('w1')[0]).toMatchObject({ url: 'https://a.com/', title: '' });
    guest.emit('page-title-updated', {}, 'Arrived');
    expect(service.historyFor('w1')).toHaveLength(1);
    expect(service.historyFor('w1')[0]).toMatchObject({ url: 'https://a.com/', title: 'Arrived' });
  });

  it("does not title a visit that is no longer the tab's page", () => {
    const guest = bound();
    guest.emit('did-navigate', {}, 'https://a.com/');
    store.addHistory('w1', { url: 'https://other.com/', title: '', at: now });
    guest.emit('page-title-updated', {}, 'Late');
    expect(service.historyFor('w1')[0]).toMatchObject({ url: 'https://other.com/', title: '' });
  });

  it("serves a workspace's history only", () => {
    store.addHistory('w1', { url: 'https://a.com', title: 'A', at: 1 });
    store.addHistory('w2', { url: 'https://b.com', title: 'B', at: 2 });
    expect(service.historyFor('w1').map((e) => e.url)).toEqual(['https://a.com']);
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

describe('live pages', () => {
  const MIN = 60_000;
  let tick: (() => void) | undefined;
  let stopped: boolean;

  beforeEach(() => {
    stopped = false;
    tick = undefined;
    service = new BrowserService({
      store,
      workspaceIdForSession: (id) => sessionWorkspace[id],
      findWindowForWorkspace: (w) => (w === 'w1' ? winA : w === 'w2' ? winB : undefined),
      send: (window, channel, payload) =>
        sent.push({ window: (window as unknown as { name: string }).name, channel, payload }),
      clearPartition,
      now: () => now,
      newId: () => `tab${++ids}`,
      every: (_ms, fn) => {
        tick = fn;
        return () => {
          stopped = true;
        };
      },
    });
  });

  const liveIds = (sessionId: string) =>
    service
      .snapshotFor(sessionId)
      .tabs.filter((t) => t.live)
      .map((t) => t.id);

  it('a tab is live only once shown, and opening one does not make it live by itself', () => {
    service.openTab('s1', 'https://a.com', 'person');
    expect(liveIds('s1')).toEqual([]);
    service.setVisible(winA, 's1', 'tab1');
    expect(liveIds('s1')).toEqual(['tab1']);
    expect(last().payload.snapshot.tabs[0].live).toBe(true);
  });

  it('keeps the page of a tab that stops being visible, until the rule unloads it', () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.openTab('s1', 'https://b.com', 'person');
    service.setVisible(winA, 's1', 'tab1');
    const g1 = new FakeGuest(11);
    service.bindGuest('tab1', g1.asWebContents(), winA);
    service.setVisible(winA, 's1', 'tab2');
    expect(liveIds('s1')).toEqual(['tab1', 'tab2']);
    left(g1);

    now += 14 * MIN;
    tick?.();
    expect(liveIds('s1')).toEqual(['tab1', 'tab2']);

    now += 1 * MIN;
    tick?.();
    expect(liveIds('s1')).toEqual(['tab2']);
    blanked(g1);
    // Its address stays, and blanking is no commit or visit.
    expect(service.listFor('s1')[0].url).toBe('https://a.com');
    expect(store.getHistory('w1').map((h) => h.url)).not.toContain('about:blank');
    expect(service.guestFor('tab1')).toBeUndefined();
    expect(last().payload.snapshot.tabs[0].live).toBe(false);
  });

  it('never unloads the visible tab, however long it has been shown', () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.setVisible(winA, 's1', 'tab1');
    now += 60 * MIN;
    tick?.();
    expect(liveIds('s1')).toEqual(['tab1']);
    // Hidden at last, it counts from then, not from when it was first shown.
    service.setVisible(winA, null, null);
    now += 14 * MIN;
    tick?.();
    expect(liveIds('s1')).toEqual(['tab1']);
    now += 1 * MIN;
    tick?.();
    expect(liveIds('s1')).toEqual([]);
  });

  it('gives a tab a new load id each time it becomes live', () => {
    service.openTab('s1', 'https://a.com', 'person');
    const loadOf = () => service.snapshotFor('s1').tabs[0].loadId;
    expect(loadOf()).toBe(0);
    service.setVisible(winA, 's1', 'tab1');
    const first = loadOf();
    expect(first).toBeGreaterThan(0);
    service.setVisible(winA, 's1', 'tab1');
    expect(loadOf()).toBe(first);
    service.setVisible(winA, null, null);
    now += 20 * MIN;
    tick?.();
    expect(loadOf()).toBe(0);
    service.setVisible(winA, 's1', 'tab1');
    expect(loadOf()).toBeGreaterThan(first);
  });

  it('shows an unloaded tab live again at its stored address', () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.setVisible(winA, 's1', 'tab1');
    service.setVisible(winA, null, null);
    now += 20 * MIN;
    tick?.();
    expect(liveIds('s1')).toEqual([]);
    service.setVisible(winA, 's1', 'tab1');
    expect(liveIds('s1')).toEqual(['tab1']);
    expect(service.listFor('s1')[0].url).toBe('https://a.com');
  });

  it('holds the cap, least recently shown first out', () => {
    for (let i = 0; i < 10; i++) {
      service.openTab(i < 5 ? 's1' : 's2', `https://e.com/${i}`, 'person');
    }
    for (let i = 1; i <= 10; i++) {
      now += 1000;
      service.setVisible(winA, i <= 5 ? 's1' : 's2', `tab${i}`);
    }
    const all = [...liveIds('s1'), ...liveIds('s2')];
    expect(all).toHaveLength(8);
    // tab1 and tab2 were shown first.
    expect(all).not.toContain('tab1');
    expect(all).not.toContain('tab2');
    expect(all).toContain('tab10');
  });

  it('a visible blank tab is not live and takes none of the cap', () => {
    for (let i = 0; i < 8; i++) service.openTab('s1', `https://e.com/${i}`, 'person');
    for (let i = 1; i <= 8; i++) {
      now += 1000;
      service.setVisible(winA, 's1', `tab${i}`);
    }
    expect(liveIds('s1')).toHaveLength(8);
    service.openTab('s1', '', 'person');
    now += 1000;
    service.setVisible(winA, 's1', 'tab9');
    expect(liveIds('s1')).toHaveLength(8);
    expect(liveIds('s1')).toContain('tab1');
    expect(liveIds('s1')).not.toContain('tab9');
  });

  it('a blank tab becomes live when it is given an address while shown', () => {
    for (let i = 0; i < 8; i++) service.openTab('s1', `https://e.com/${i}`, 'person');
    for (let i = 1; i <= 8; i++) {
      now += 1000;
      service.setVisible(winA, 's1', `tab${i}`);
    }
    service.openTab('s1', '', 'person');
    now += 1000;
    service.setVisible(winA, 's1', 'tab9');
    service.navigate('tab9', 'https://new.com');
    expect(liveIds('s1')).toHaveLength(8);
    expect(liveIds('s1')).toContain('tab9');
    expect(liveIds('s1')).not.toContain('tab1');
  });

  it('a blank tab given an address while hidden is live once shown', () => {
    service.openTab('s1', '', 'person');
    service.navigate('tab1', 'https://new.com');
    expect(liveIds('s1')).toEqual([]);
    service.setVisible(winA, 's1', 'tab1');
    expect(liveIds('s1')).toEqual(['tab1']);
  });

  it('a tool call on a blank tab does not make it live', () => {
    service.openTab('s1', '', 'person');
    const release = service.holdForToolCall('tab1');
    expect(release).not.toBeNull();
    expect(liveIds('s1')).toEqual([]);
    release?.();
  });

  it('a tool call in flight keeps a hidden tab live, and its end counts as use', () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.setVisible(winA, 's1', 'tab1');
    service.setVisible(winA, null, null);
    const release = service.holdForToolCall('tab1');
    expect(release).not.toBeNull();
    now += 60 * MIN;
    tick?.();
    expect(liveIds('s1')).toEqual(['tab1']);
    release?.();
    now += 14 * MIN;
    tick?.();
    expect(liveIds('s1')).toEqual(['tab1']);
    now += 1 * MIN;
    tick?.();
    expect(liveIds('s1')).toEqual([]);
  });

  it('a tool call makes an unloaded tab live, and overlapping calls each need releasing', () => {
    service.openTab('s1', 'https://a.com', 'person');
    const first = service.holdForToolCall('tab1');
    const second = service.holdForToolCall('tab1');
    expect(liveIds('s1')).toEqual(['tab1']);
    first?.();
    first?.();
    now += 60 * MIN;
    tick?.();
    expect(liveIds('s1')).toEqual(['tab1']);
    second?.();
    now += 60 * MIN;
    tick?.();
    expect(liveIds('s1')).toEqual([]);
    expect(service.holdForToolCall('nope')).toBeNull();
  });

  it('takes a tab of another session, or an unknown one, as nothing shown', () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.setVisible(winA, 's2', 'tab1');
    service.setVisible(winA, 's1', 'ghost');
    expect(liveIds('s1')).toEqual([]);
  });

  it('closing a tab and a window let go of liveness', () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.openTab('s1', 'https://b.com', 'person');
    service.setVisible(winA, 's1', 'tab1');
    service.setVisible(winA, 's1', 'tab2');
    service.closeTab('tab2');
    expect(liveIds('s1')).toEqual(['tab1']);
    service.detachWindow(winA);
    expect(liveIds('s1')).toEqual([]);
  });

  it('a guest binding for a tab not in the set makes it live rather than leaving it half-bound', () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.bindGuest('tab1', new FakeGuest(11).asWebContents(), winA);
    expect(liveIds('s1')).toEqual(['tab1']);
  });

  it('stops its timer when destroyed', () => {
    service.destroyAll();
    expect(stopped).toBe(true);
  });
});

describe('agent calls', () => {
  const tabOf = (sessionId: string, tabId: string) =>
    service.snapshotFor(sessionId).tabs.find((t) => t.id === tabId);

  it('marks a tab agent-active while a call holds it, pushing each change', () => {
    service.openTab('s1', 'https://a.com', 'agent');
    const pushes = sent.length;
    const release = service.holdForToolCall('tab1');
    expect(tabOf('s1', 'tab1')).toMatchObject({ live: true, agentActive: true });
    expect(sent.length).toBeGreaterThan(pushes);
    expect(last().payload.snapshot.tabs[0]).toMatchObject({ live: true, agentActive: true });

    release?.();
    expect(tabOf('s1', 'tab1')).toMatchObject({ live: true, agentActive: false });
    expect(last().payload.snapshot.tabs[0].agentActive).toBe(false);
  });

  it('stays agent-active until the last of overlapping calls ends', () => {
    service.openTab('s1', 'https://a.com', 'agent');
    const first = service.holdForToolCall('tab1');
    const second = service.holdForToolCall('tab1');
    first?.();
    first?.();
    expect(tabOf('s1', 'tab1')?.agentActive).toBe(true);
    const pushes = sent.length;
    second?.();
    expect(tabOf('s1', 'tab1')?.agentActive).toBe(false);
    expect(sent.length).toBe(pushes + 1);
    second?.();
    expect(sent.length).toBe(pushes + 1);
  });

  it('a call ending on a closed tab pushes nothing', () => {
    service.openTab('s1', 'https://a.com', 'agent');
    const release = service.holdForToolCall('tab1');
    service.closeTab('tab1');
    const pushes = sent.length;
    release?.();
    expect(sent.length).toBe(pushes);
  });

  it('says whether an agent can have a tab’s page', () => {
    service.openTab('s1', 'https://a.com', 'agent');
    service.openTab('s1', '', 'agent');
    expect(service.pageAvailability('tab1')).toBe('ready');
    expect(service.pageAvailability('tab2')).toBe('blank');
    expect(service.pageAvailability('nope')).toBe('missing');

    service = new BrowserService({
      store,
      workspaceIdForSession: (id) => sessionWorkspace[id],
      findWindowForWorkspace: () => undefined,
      send: () => {},
      clearPartition,
    });
    expect(service.pageAvailability('tab1')).toBe('no-window');
  });

  it('a window that is closing holds nothing', () => {
    const closing = { name: 'C', isDestroyed: () => true } as unknown as BrowserWindow;
    service = new BrowserService({
      store,
      workspaceIdForSession: (id) => sessionWorkspace[id],
      findWindowForWorkspace: () => closing,
      send: () => {},
      clearPartition,
      newId: () => `tab${++ids}`,
    });
    service.openTab('s1', 'https://a.com', 'agent');
    expect(service.pageAvailability(`tab${ids}`)).toBe('no-window');
  });

  it('tells its watchers when a page binds to its tab', () => {
    service.openTab('s1', 'https://a.com', 'agent');
    const bound: Array<[string, WebContents]> = [];
    const stop = service.onGuestBound((tabId, guest) => bound.push([tabId, guest]));
    const guest = new FakeGuest(11).asWebContents();
    service.bindGuest('tab1', guest, winA);
    expect(bound).toEqual([['tab1', guest]]);
    expect(service.guestFor('tab1')).toBe(guest);

    stop();
    service.bindGuest('tab1', new FakeGuest(12).asWebContents(), winA);
    expect(bound).toHaveLength(1);
  });

  describe('tells its watchers when a tab’s page goes', () => {
    let gone: string[];
    let g1: FakeGuest;
    beforeEach(() => {
      gone = [];
      service.onGuestGone((tabId) => gone.push(tabId));
      service.openTab('s1', 'https://a.com', 'agent');
      g1 = new FakeGuest(11);
      service.bindGuest('tab1', g1.asWebContents(), winA);
    });

    it('when the guest is destroyed', () => {
      g1.destroyed = true;
      g1.emit('destroyed');
      expect(gone).toEqual(['tab1']);
    });

    it('when the tab closes', () => {
      service.closeTab('tab1');
      expect(gone).toEqual(['tab1']);
    });

    it('when another page binds to the tab', () => {
      service.bindGuest('tab1', new FakeGuest(12).asWebContents(), winA);
      expect(gone).toEqual(['tab1']);
    });

    it('naming the page that went, so news of a replaced page can be told apart', () => {
      const pages: WebContents[] = [];
      service.onGuestGone((_tabId, guest) => pages.push(guest));
      const g2 = new FakeGuest(12);
      service.bindGuest('tab1', g2.asWebContents(), winA);
      service.closeTab('tab1');
      expect(pages).toEqual([g1.asWebContents(), g2.asWebContents()]);
    });

    it('when its window lets go of it', () => {
      service.detachWindow(winA);
      expect(gone).toEqual(['tab1']);
    });

    it('when the session is deleted', () => {
      service.destroySession('s1');
      expect(gone).toEqual(['tab1']);
    });

    it('when the app quits', () => {
      service.destroyAll();
      expect(gone).toEqual(['tab1']);
    });

    it('and never for a tab that had no page', () => {
      service.openTab('s1', 'https://b.com', 'agent');
      service.closeTab('tab2');
      expect(gone).toEqual([]);
    });
  });
});

describe('certificates', () => {
  const AUTHORITY = 'net::ERR_CERT_AUTHORITY_INVALID';
  const certificate = (fingerprint: string) => ({ fingerprint });

  function refuse(
    guest: FakeGuest,
    options: { url?: string; error?: string; fingerprint?: string } = {},
  ) {
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    guest.emit(
      'certificate-error',
      event,
      options.url ?? 'https://127.0.0.1:8443/',
      options.error ?? AUTHORITY,
      certificate(options.fingerprint ?? 'sha256/AAAA'),
      callback,
      true,
    );
    return { event, callback };
  }

  function guarded(url = 'https://127.0.0.1:8443/') {
    service.openTab('s1', url, 'person');
    const guest = new FakeGuest(21);
    service.guardGuest(guest.asWebContents(), winA, 'w1', 21);
    service.bindGuest('tab1', guest.asWebContents(), winA);
    return guest;
  }
  const error = () => last().payload.snapshot.tabs[0].error;

  it('refuses by default and shows the certificate, with a way on for a local dev server', () => {
    const guest = guarded();
    const { event, callback } = refuse(guest);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    guest.emit('did-fail-load', {}, -202, 'ERR', 'https://127.0.0.1:8443/', true);
    expect(error()).toEqual({
      kind: 'certificate',
      url: 'https://127.0.0.1:8443/',
      host: '127.0.0.1',
      error: AUTHORITY,
      canContinue: true,
    });
  });

  it('offers no way on for a host that is not on this machine', () => {
    const remote = guarded('https://example.com/');
    refuse(remote, { url: 'https://example.com/' });
    remote.emit('did-fail-load', {}, -202, 'x', 'https://example.com/', true);
    expect(error()).toMatchObject({ kind: 'certificate', canContinue: false });
    expect(service.continueCertificate('tab1')).toBe(false);
  });

  it('offers no way on for an expired certificate on this machine', () => {
    const guest = guarded();
    refuse(guest, { error: 'net::ERR_CERT_DATE_INVALID' });
    guest.emit('did-fail-load', {}, -201, 'x', 'https://127.0.0.1:8443/', true);
    expect(error()).toMatchObject({ kind: 'certificate', canContinue: false });
    expect(service.continueCertificate('tab1')).toBe(false);
  });

  it('does not take a later, unrelated failure for the old refusal', () => {
    const guest = guarded();
    refuse(guest);
    guest.emit('did-fail-load', {}, -102, 'REFUSED', 'https://127.0.0.1:8443/', true);
    expect(error()).toMatchObject({ kind: 'unreachable' });
  });

  it('keeps the certificate error when Chromium then commits its error page', () => {
    const guest = guarded();
    refuse(guest);
    guest.emit('did-fail-load', {}, -202, 'x', 'https://127.0.0.1:8443/', true);
    guest.emit('did-navigate', {}, 'https://127.0.0.1:8443/');
    expect(error()).toMatchObject({ kind: 'certificate' });
  });

  it('on "Continue anyway" pins that certificate, reloads, and allows exactly it', () => {
    const guest = guarded();
    refuse(guest);
    guest.emit('did-fail-load', {}, -202, 'x', 'https://127.0.0.1:8443/', true);
    expect(service.continueCertificate('tab1')).toBe(true);
    expect(guest.loadURL).toHaveBeenCalledWith('https://127.0.0.1:8443/');

    const same = refuse(guest);
    expect(same.event.preventDefault).toHaveBeenCalled();
    expect(same.callback).toHaveBeenCalledWith(true);

    const other = refuse(guest, { fingerprint: 'sha256/BBBB' });
    expect(other.event.preventDefault).not.toHaveBeenCalled();
    const elsewhere = refuse(guest, { url: 'https://localhost:8443/' });
    expect(elsewhere.event.preventDefault).not.toHaveBeenCalled();
    const expired = refuse(guest, { error: 'net::ERR_CERT_DATE_INVALID' });
    expect(expired.event.preventDefault).not.toHaveBeenCalled();
  });

  it("shares an approval with the workspace's other pages and no other workspace's", () => {
    const first = guarded();
    refuse(first);
    first.emit('did-fail-load', {}, -202, 'x', 'https://127.0.0.1:8443/', true);
    service.continueCertificate('tab1');

    const sibling = new FakeGuest(22);
    service.guardGuest(sibling.asWebContents(), winA, 'w1', 22);
    expect(refuse(sibling).callback).toHaveBeenCalledWith(true);

    const foreign = new FakeGuest(23);
    service.guardGuest(foreign.asWebContents(), winB, 'w2', 23);
    expect(refuse(foreign).callback).not.toHaveBeenCalled();
  });

  it('only a main-frame refusal can be continued', () => {
    const guest = guarded();
    guest.emit(
      'certificate-error',
      { preventDefault: vi.fn() },
      'https://127.0.0.1:8443/img.png',
      AUTHORITY,
      certificate('sha256/AAAA'),
      vi.fn(),
      false,
    );
    guest.emit('did-fail-load', {}, -202, 'x', 'https://127.0.0.1:8443/', true);
    expect(error()).toMatchObject({ kind: 'unreachable' });
  });

  it('shows a refusal that happened before the guest was bound', () => {
    service.openTab('s1', 'https://127.0.0.1:8443/', 'person');
    const guest = new FakeGuest(24);
    service.noteAttached(guest.asWebContents(), 24);
    service.guardGuest(guest.asWebContents(), winA, 'w1', 24);
    refuse(guest);
    guest.emit('did-fail-load', {}, -202, 'x', 'https://127.0.0.1:8443/', true);
    service.bindGuest('tab1', guest.asWebContents(), winA);
    expect(error()).toMatchObject({ kind: 'certificate', canContinue: true });
  });

  it('a workspace delete drops its approvals', () => {
    const guest = guarded();
    refuse(guest);
    guest.emit('did-fail-load', {}, -202, 'x', 'https://127.0.0.1:8443/', true);
    service.continueCertificate('tab1');
    expect(service.certificates.pinnedFor('w1', '127.0.0.1')).toBeDefined();
    service.destroyWorkspace('w1', ['s1']);
    expect(service.certificates.pinnedFor('w1', '127.0.0.1')).toBeUndefined();
  });
});

describe('clearing browsing data', () => {
  it('drops history and approvals, resets live zoom, and clears the partition', async () => {
    service.openTab('s1', 'https://a.com', 'person');
    service.openTab('s3', 'https://c.com', 'person');
    service.recordCommit('tab1', 'https://a.com/x', 'x');
    service.recordCommit('tab2', 'https://c.com/x', 'x');
    service.certificates.approve('w1', '127.0.0.1', 'sha256/AAAA');
    service.certificates.approve('w2', '127.0.0.1', 'sha256/BBBB');
    const mine = new FakeGuest(31);
    const theirs = new FakeGuest(32);
    mine.zoomLevel = 2;
    theirs.zoomLevel = 2;
    service.bindGuest('tab1', mine.asWebContents(), winA);
    service.bindGuest('tab2', theirs.asWebContents(), winB);

    await service.clearBrowsingData('w1');

    expect(store.getHistory('w1')).toEqual([]);
    expect(store.getHistory('w2')).toHaveLength(1);
    expect(service.certificates.pinnedFor('w1', '127.0.0.1')).toBeUndefined();
    expect(service.certificates.pinnedFor('w2', '127.0.0.1')).toBeDefined();
    expect(mine.zoomLevel).toBe(0);
    expect(theirs.zoomLevel).toBe(2);
    expect(clearPartition).toHaveBeenCalledWith('w1');
    expect(clearPartition).not.toHaveBeenCalledWith('w2');
    // Open pages stay open.
    expect(mine.stop).not.toHaveBeenCalled();
  });

  it('tells the caller when the partition could not be cleared', async () => {
    clearPartition.mockRejectedValueOnce(new Error('disk'));
    await expect(service.clearBrowsingData('w1')).rejects.toThrow('disk');
  });
});

describe('sign-in', () => {
  function host() {
    const send = vi.fn();
    return {
      send,
      window: {
        isDestroyed: () => false,
        webContents: { send, isDestroyed: () => false },
      } as unknown as BrowserWindow,
    };
  }
  const info = { isProxy: false, realm: 'Staging' };
  const URL_S = 'https://staging.example.com/admin';
  // A first load starts before the guard exists, so no navigation is announced first.
  const navigate = (_guest: FakeGuest) => {};

  function ask(guest: FakeGuest, url: string, isRequestForNavigation = true, authInfo = info) {
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    const details = { url, isRequestForNavigation, isMainFrame: true };
    guest.emit('login', event, details, authInfo, callback);
    return { event, callback };
  }

  it('asks for the page’s own navigation, even before the guest is bound, and answers the page', () => {
    const { send, window } = host();
    const guest = new FakeGuest(41);
    service.guardGuest(guest.asWebContents(), window, 'w1', 41);
    navigate(guest);
    const { callback } = ask(guest, URL_S);
    const request = send.mock.calls[0];
    expect(request[0]).toBe(IPC_CHANNELS.BROWSER_AUTH_REQUEST);
    expect(request[1]).toMatchObject({
      tabId: null,
      origin: 'https://staging.example.com',
      realm: 'Staging',
    });
    expect(service.auth.answer(window, request[1].id, { username: 'u', password: 'p' })).toBe(true);
    expect(callback).toHaveBeenCalledWith('u', 'p');
  });

  it('names the tab once the guest binds', () => {
    const { send, window } = host();
    service.openTab('s1', URL_S, 'person');
    const guest = new FakeGuest(48);
    service.guardGuest(guest.asWebContents(), window, 'w1', 48);
    navigate(guest);
    ask(guest, URL_S);
    service.bindGuest('tab1', guest.asWebContents(), window);
    const requests = send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.BROWSER_AUTH_REQUEST);
    expect(requests.at(-1)?.[1]).toMatchObject({ tabId: 'tab1' });
  });

  it('cancels a background request, an iframe’s navigation and a proxy', () => {
    const { send, window } = host();
    const guest = new FakeGuest(42);
    service.guardGuest(guest.asWebContents(), window, 'w1', 42);
    navigate(guest);
    expect(ask(guest, URL_S, false).callback).toHaveBeenCalledWith();
    const frame = { preventDefault: vi.fn() };
    const frameCallback = vi.fn();
    guest.emit(
      'login',
      frame,
      { url: URL_S, isRequestForNavigation: true, isMainFrame: false },
      info,
      frameCallback,
    );
    expect(frameCallback).toHaveBeenCalledWith();
    const proxy = ask(guest, URL_S, true, { isProxy: true, realm: '' });
    expect(proxy.callback).toHaveBeenCalledWith();
    expect(send).not.toHaveBeenCalled();
  });

  it('cancels when the tab is closed, and when the guest is destroyed', () => {
    const { send, window } = host();
    service.openTab('s1', URL_S, 'person');
    const guest = new FakeGuest(43);
    service.guardGuest(guest.asWebContents(), window, 'w1', 43);
    service.bindGuest('tab1', guest.asWebContents(), window);
    navigate(guest);
    const closing = ask(guest, URL_S);
    service.closeTab('tab1');
    expect(closing.callback).toHaveBeenCalledWith();
    expect(send.mock.calls.some((c) => c[0] === IPC_CHANNELS.BROWSER_AUTH_CANCELLED)).toBe(true);

    const second = new FakeGuest(44);
    service.guardGuest(second.asWebContents(), window, 'w1', 44);
    navigate(second);
    const dying = ask(second, URL_S);
    second.emit('destroyed');
    expect(dying.callback).toHaveBeenCalledWith();
  });

  it('cancels when the window is detached', () => {
    const { window } = host();
    const guest = new FakeGuest(45);
    service.guardGuest(guest.asWebContents(), window, 'w1', 45);
    navigate(guest);
    const waiting = ask(guest, URL_S);
    service.detachWindow(window);
    expect(waiting.callback).toHaveBeenCalledWith();
  });
});
