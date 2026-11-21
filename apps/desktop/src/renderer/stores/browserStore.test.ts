import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserSessionSnapshot, BrowserTabSnapshot } from '../../shared/browser';

vi.mock('../services/browserBridge', () => ({
  browserBridge: {
    get: vi.fn(),
    onSnapshot: vi.fn(() => () => {}),
  },
}));

import { browserBridge } from '../services/browserBridge';
import { useBrowserAgentDotStore } from './browserAgentDotStore';
import {
  activeTabOf,
  applyBrowserSnapshot,
  forgetBrowser,
  loadBrowser,
  NO_BROWSER,
  subscribeToBrowser,
  useBrowserStore,
} from './browserStore';

const tab = (id: string): BrowserTabSnapshot => ({
  id,
  url: `https://example.com/${id}`,
  title: id,
  openedBy: 'person',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  live: true,
  loadId: 1,
  agentActive: false,
});

const snapshot = (activeTabId: string | null, ...ids: string[]): BrowserSessionSnapshot => ({
  tabs: ids.map(tab),
  activeTabId,
});

const held = () => useBrowserStore.getState().snapshots;

beforeEach(() => {
  useBrowserStore.setState({ snapshots: {}, pushes: {} });
  useBrowserAgentDotStore.setState({ dots: {} });
  vi.clearAllMocks();
});

describe('browserStore', () => {
  it('a pushed snapshot replaces that session and leaves the others', () => {
    applyBrowserSnapshot({ sessionId: 'a', snapshot: snapshot('t1', 't1') });
    applyBrowserSnapshot({ sessionId: 'b', snapshot: snapshot('t2', 't2') });
    applyBrowserSnapshot({ sessionId: 'a', snapshot: snapshot('t3', 't3', 't4') });
    expect(held().a.tabs.map((t) => t.id)).toEqual(['t3', 't4']);
    expect(held().b.activeTabId).toBe('t2');
  });

  it('activeTabOf finds the active tab, and none when nothing is active', () => {
    expect(activeTabOf(snapshot('t2', 't1', 't2'))?.id).toBe('t2');
    expect(activeTabOf(snapshot(null, 't1'))).toBeUndefined();
    expect(activeTabOf(NO_BROWSER)).toBeUndefined();
  });

  it('loadBrowser stores the fetched snapshot', async () => {
    vi.mocked(browserBridge.get).mockResolvedValue(snapshot('t1', 't1'));
    await loadBrowser('a');
    expect(browserBridge.get).toHaveBeenCalledWith('a');
    expect(held().a.activeTabId).toBe('t1');
  });

  it('a push that arrives while the fetch is in flight wins over its older answer', async () => {
    let answer!: (value: BrowserSessionSnapshot) => void;
    vi.mocked(browserBridge.get).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const loading = loadBrowser('a');
    applyBrowserSnapshot({ sessionId: 'a', snapshot: snapshot('new', 'new') });
    answer(snapshot('old', 'old'));
    await loading;
    expect(held().a.activeTabId).toBe('new');
  });

  it('forgetBrowser drops one session', () => {
    applyBrowserSnapshot({ sessionId: 'a', snapshot: snapshot('t1', 't1') });
    applyBrowserSnapshot({ sessionId: 'b', snapshot: snapshot('t2', 't2') });
    forgetBrowser('a');
    expect(Object.keys(held())).toEqual(['b']);
  });

  it('an answer in flight for a forgotten session is dropped, not stored', async () => {
    let answer!: (value: BrowserSessionSnapshot) => void;
    vi.mocked(browserBridge.get).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const loading = loadBrowser('a');
    forgetBrowser('a');
    answer(snapshot('old', 'old'));
    await loading;
    expect(held().a).toBeUndefined();
  });

  it('a push showing an agent at work lights the dot, measured against what was held', async () => {
    applyBrowserSnapshot({ sessionId: 'a', snapshot: snapshot('t1', 't1') });
    expect(useBrowserAgentDotStore.getState().dots).toEqual({});
    const used = snapshot('t1', 't1');
    used.tabs[0] = { ...used.tabs[0], agentActive: true };
    applyBrowserSnapshot({ sessionId: 'a', snapshot: used });
    expect(useBrowserAgentDotStore.getState().dots).toEqual({ a: true });
    // A fetched snapshot is only a starting point: it never lights one.
    const opened = snapshot('t2', 't2');
    opened.tabs[0] = { ...opened.tabs[0], openedBy: 'agent' };
    vi.mocked(browserBridge.get).mockResolvedValue(opened);
    await loadBrowser('b');
    expect(useBrowserAgentDotStore.getState().dots).toEqual({ a: true });
  });

  it('subscribeToBrowser feeds pushes into the store and returns the unsubscribe', () => {
    const unsubscribe = () => {};
    vi.mocked(browserBridge.onSnapshot).mockReturnValue(unsubscribe);
    expect(subscribeToBrowser()).toBe(unsubscribe);
    const listener = vi.mocked(browserBridge.onSnapshot).mock.calls[0][0];
    listener({ sessionId: 'a', snapshot: snapshot('t1', 't1') });
    expect(held().a.activeTabId).toBe('t1');
  });
});
