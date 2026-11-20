import { beforeEach, describe, expect, it } from 'vitest';
import type { BrowserSessionSnapshot, BrowserTabSnapshot } from '../../shared/browser';
import {
  agentNews,
  clearAgentDot,
  nextAgentDot,
  noteBrowserPush,
  useBrowserAgentDotStore,
} from './browserAgentDotStore';
import { showBrowserSlot, useBrowserSlotStore } from './browserSlotStore';

const tab = (id: string, fields: Partial<BrowserTabSnapshot> = {}): BrowserTabSnapshot => ({
  id,
  url: `https://example.com/${id}`,
  title: id,
  openedBy: 'person',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  live: false,
  loadId: 0,
  agentActive: false,
  ...fields,
});

const snapshot = (...tabs: BrowserTabSnapshot[]): BrowserSessionSnapshot => ({
  tabs,
  activeTabId: tabs[0]?.id ?? null,
});

describe('agentNews', () => {
  it('is a tab an agent opened that was not there before', () => {
    expect(agentNews(snapshot(tab('a')), snapshot(tab('a'), tab('b', { openedBy: 'agent' })))).toBe(
      true,
    );
  });

  it('is a tab becoming agent-active', () => {
    expect(agentNews(snapshot(tab('a')), snapshot(tab('a', { agentActive: true })))).toBe(true);
  });

  it('is not an agent tab already there, a call still running, or the person’s tabs', () => {
    const before = snapshot(tab('a', { openedBy: 'agent', agentActive: true }), tab('b'));
    const after = snapshot(
      tab('a', { openedBy: 'agent', agentActive: true, title: 'Loaded' }),
      tab('b', { url: 'https://example.com/moved' }),
      tab('c'),
    );
    expect(agentNews(before, after)).toBe(false);
    // A call ending is not news either.
    expect(agentNews(before, snapshot(tab('a', { openedBy: 'agent' }), tab('b')))).toBe(false);
  });

  it('reads a session the window held nothing for as having had no tabs', () => {
    expect(agentNews(undefined, snapshot(tab('a', { openedBy: 'agent' })))).toBe(true);
    expect(agentNews(undefined, snapshot(tab('a')))).toBe(false);
  });
});

describe('nextAgentDot', () => {
  const news = { previous: snapshot(), next: snapshot(tab('a', { openedBy: 'agent' })) };
  const quiet = { previous: snapshot(tab('a')), next: snapshot(tab('a')) };

  it('lights on news while the panel is not showing the session, and stays lit', () => {
    expect(nextAgentDot({ dot: false, shown: false, ...news })).toBe(true);
    expect(nextAgentDot({ dot: true, shown: false, ...quiet })).toBe(true);
    expect(nextAgentDot({ dot: false, shown: false, ...quiet })).toBe(false);
  });

  it('never lights while the panel shows the session, and goes out there', () => {
    expect(nextAgentDot({ dot: false, shown: true, ...news })).toBe(false);
    expect(nextAgentDot({ dot: true, shown: true, ...quiet })).toBe(false);
  });
});

describe('the dot per session', () => {
  const dots = () => useBrowserAgentDotStore.getState().dots;

  beforeEach(() => {
    useBrowserAgentDotStore.setState({ dots: {} });
    useBrowserSlotStore.setState({ sessionId: null });
  });

  it('lights for a session whose panel is not on screen, and only that one', () => {
    showBrowserSlot('watched');
    noteBrowserPush('watched', snapshot(), snapshot(tab('a', { openedBy: 'agent' })));
    noteBrowserPush('elsewhere', snapshot(), snapshot(tab('b', { openedBy: 'agent' })));
    expect(dots()).toEqual({ elsewhere: true });
  });

  it('goes out when the panel shows that session', () => {
    noteBrowserPush('s', snapshot(), snapshot(tab('a', { agentActive: true })));
    noteBrowserPush('t', snapshot(), snapshot(tab('b', { agentActive: true })));
    clearAgentDot('s');
    expect(dots()).toEqual({ t: true });
  });
});
