import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentPages,
  BLANK_TAB_MESSAGE,
  ENSURE_LIVE_TIMEOUT_MS,
  NO_TAB_MESSAGE,
  NO_WINDOW_MESSAGE,
  NOT_IN_TIME_MESSAGE,
} from './AgentPages';
import type { AgentPagesBrowser } from './AgentPages';
import type { PageAvailability } from './BrowserService';
import { DEVTOOLS_OPEN_MESSAGE } from './CdpRelay';

/** The parts of `BrowserService` a call uses, with what it did recorded. */
class FakeBrowser implements AgentPagesBrowser {
  availability: Record<string, PageAvailability> = {};
  guests: Record<string, WebContents> = {};
  holds: Record<string, number> = {};
  /** Tabs with a page now (shown, or kept after being shown). */
  live = new Set<string>();
  readonly releases: string[] = [];
  private readonly watchers = new Set<(tabId: string, guest: WebContents) => void>();

  pageAvailability(tabId: string): PageAvailability {
    return this.availability[tabId] ?? 'missing';
  }

  holdForToolCall(tabId: string): (() => void) | null {
    if (this.pageAvailability(tabId) === 'missing') return null;
    this.holds[tabId] = (this.holds[tabId] ?? 0) + 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds[tabId] -= 1;
      this.releases.push(tabId);
    };
  }

  guestFor(tabId: string): WebContents | undefined {
    return this.guests[tabId];
  }

  isLive(tabId: string): boolean {
    return this.live.has(tabId);
  }

  onGuestBound(watcher: (tabId: string, guest: WebContents) => void): () => void {
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  get watching(): number {
    return this.watchers.size;
  }

  /** What `bindGuest` does once the window's element attaches. */
  bind(tabId: string, guest: WebContents) {
    this.guests[tabId] = guest;
    for (const watcher of [...this.watchers]) watcher(tabId, guest);
  }
}

const guest = (id: number, devToolsOpen = false) =>
  ({ id, isDevToolsOpened: () => devToolsOpen }) as unknown as WebContents;

let browser: FakeBrowser;
let pages: AgentPages;
let mounted: string[];

beforeEach(() => {
  vi.useFakeTimers();
  browser = new FakeBrowser();
  mounted = [];
  pages = new AgentPages(browser, (tabId) => mounted.push(tabId));
});

afterEach(() => {
  vi.useRealTimers();
});

// The load an agent's call causes is the agent's doing, and the tab is in its hands.
describe('a call that mounts a page', () => {
  it('says so as it mounts a page that was not live, before the page binds', async () => {
    browser.availability.tab1 = 'ready';
    const call = pages.beginToolCall('tab1');
    expect(mounted).toEqual(['tab1']);
    browser.bind('tab1', guest(7));
    await call;
    expect(mounted).toEqual(['tab1']);
  });

  it('says nothing for a page already live, bound or still binding', async () => {
    browser.availability.tab1 = 'ready';
    browser.live.add('tab1');
    browser.guests.tab1 = guest(7);
    await pages.beginToolCall('tab1');
    browser.availability.tab2 = 'ready';
    browser.live.add('tab2');
    const binding = pages.beginToolCall('tab2');
    browser.bind('tab2', guest(8));
    await binding;
    expect(mounted).toEqual([]);
  });

  it('says nothing for a call refused before it holds anything', async () => {
    browser.availability.tab1 = 'blank';
    await expect(pages.beginToolCall('tab1')).rejects.toThrow(BLANK_TAB_MESSAGE);
    expect(mounted).toEqual([]);
  });
});

describe('AgentPages.beginToolCall', () => {
  it('hands over a page that is already bound, holding its tab until the call ends', async () => {
    browser.availability.tab1 = 'ready';
    browser.guests.tab1 = guest(7);
    const call = await pages.beginToolCall('tab1');
    expect(call.guest).toBe(browser.guests.tab1);
    expect(browser.holds.tab1).toBe(1);
    call.end();
    call.end();
    expect(browser.holds.tab1).toBe(0);
    expect(browser.releases).toEqual(['tab1']);
  });

  it('holds a tab with no page first, which has the window mount it, then waits for it to bind', async () => {
    browser.availability.tab1 = 'ready';
    const pending = pages.beginToolCall('tab1');
    // Held before anything binds: the hold is what makes the tab live.
    expect(browser.holds.tab1).toBe(1);
    browser.bind('tab2', guest(1));
    const page = guest(8);
    browser.bind('tab1', page);
    const call = await pending;
    expect(call.guest).toBe(page);
    expect(browser.watching).toBe(0);
    call.end();
    expect(browser.holds.tab1).toBe(0);
  });

  it('gives up when nothing binds in time, letting go of the tab', async () => {
    browser.availability.tab1 = 'ready';
    const pending = pages.beginToolCall('tab1');
    const outcome = expect(pending).rejects.toThrow(NOT_IN_TIME_MESSAGE);
    await vi.advanceTimersByTimeAsync(ENSURE_LIVE_TIMEOUT_MS - 1);
    expect(browser.holds.tab1).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(browser.holds.tab1).toBe(0);
    expect(browser.watching).toBe(0);
    // A bind after giving up changes nothing.
    browser.bind('tab1', guest(9));
    expect(browser.holds.tab1).toBe(0);
  });

  it('says why when the tab stopped being usable while it waited', async () => {
    browser.availability.tab1 = 'ready';
    const pending = pages.beginToolCall('tab1');
    const outcome = expect(pending).rejects.toThrow(NO_WINDOW_MESSAGE);
    browser.availability.tab1 = 'no-window';
    await vi.advanceTimersByTimeAsync(ENSURE_LIVE_TIMEOUT_MS);
    await outcome;
  });

  it.each([
    ['no-window', NO_WINDOW_MESSAGE],
    ['blank', BLANK_TAB_MESSAGE],
    ['missing', NO_TAB_MESSAGE],
  ] as const)('refuses a tab that is %s, holding nothing', async (availability, message) => {
    browser.availability.tab1 = availability;
    browser.guests.tab1 = guest(7);
    await expect(pages.beginToolCall('tab1')).rejects.toThrow(message);
    expect(browser.holds.tab1 ?? 0).toBe(0);
    expect(browser.watching).toBe(0);
  });

  it('refuses a page the person has DevTools open on, before holding its tab', async () => {
    browser.availability.tab1 = 'ready';
    browser.guests.tab1 = guest(7, true);
    await expect(pages.beginToolCall('tab1')).rejects.toThrow(DEVTOOLS_OPEN_MESSAGE);
    // Never held, so the tab was never marked as the agent's, even for a moment.
    expect(browser.holds.tab1 ?? 0).toBe(0);
    expect(browser.releases).toEqual([]);
    expect(browser.watching).toBe(0);

    browser.guests.tab1 = guest(7, false);
    (await pages.beginToolCall('tab1')).end();
    expect(browser.releases).toEqual(['tab1']);
  });

  it('asks a person to open the workspace when no window holds it', () => {
    expect(NO_WINDOW_MESSAGE).toBe('Open this workspace in a window to use its browser.');
  });

  it('lets overlapping calls on one tab each hold it and wait for the same page', async () => {
    browser.availability.tab1 = 'ready';
    const first = pages.beginToolCall('tab1');
    const second = pages.beginToolCall('tab1');
    expect(browser.holds.tab1).toBe(2);
    const page = guest(3);
    browser.bind('tab1', page);
    const [a, b] = await Promise.all([first, second]);
    expect(a.guest).toBe(page);
    expect(b.guest).toBe(page);
    a.end();
    expect(browser.holds.tab1).toBe(1);
    b.end();
    expect(browser.holds.tab1).toBe(0);
  });
});
