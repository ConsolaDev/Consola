import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import type { Browser, Page } from 'playwright-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCall } from './AgentPages';
import type { CdpRelayOptions } from './CdpRelay';
import { DEVTOOLS_OPEN_MESSAGE } from './CdpRelay';
import {
  CONSOLE_ERRORS_KEPT,
  type DriverRelay,
  FAILED_REQUESTS_KEPT,
  PageDriver,
  RELEASE_CONSOLE_EVERY,
} from './PageDriver';

const T0 = 1_700_000_000_000;

/** `webContents.debugger`: records what main sends it, and emits page events on demand. */
class FakeDebugger extends EventEmitter {
  readonly sent: Array<{ method: string; params: unknown; sessionId?: string }> = [];
  sendCommand = vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
    this.sent.push(sessionId === undefined ? { method, params } : { method, params, sessionId });
    return {};
  });
  /** As Electron emits it: the page itself has an empty session id. */
  event(method: string, params: unknown, sessionId = '') {
    this.emit('message', {}, method, params, sessionId);
  }
  consoleError(text: string, at: number, sessionId = '') {
    this.event(
      'Runtime.consoleAPICalled',
      { type: 'error', args: [{ type: 'string', value: text }], timestamp: at },
      sessionId,
    );
  }
  failedRequest(url: string, at: number) {
    this.event('Log.entryAdded', {
      entry: {
        source: 'network',
        level: 'error',
        text: 'Failed to load resource',
        url,
        timestamp: at,
      },
    });
  }
}

class FakeGuest extends EventEmitter {
  readonly debugger = new FakeDebugger();
  devToolsOpen = false;
  constructor(public readonly id: number) {
    super();
  }
  asWebContents() {
    return this as unknown as WebContents;
  }
}

class FakeRelay implements DriverRelay {
  isClosed = false;
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  readonly focus: boolean[] = [];
  constructor(
    public readonly guest: FakeGuest,
    private readonly options: CdpRelayOptions,
  ) {}
  send() {}
  close(reason = 'The relay was closed.') {
    if (this.isClosed) return;
    this.isClosed = true;
    this.onclose?.(reason);
    this.options.onClose?.(reason);
  }
  async setFocusEmulation(enabled: boolean) {
    if (this.isClosed) throw new Error('The relay is closed.');
    this.focus.push(enabled);
  }
}

class FakePage {
  outline = '- heading "Fixture" [level=1] [ref=e1]';
  ariaSnapshot = vi.fn(async (_options?: unknown) => this.outline);
  screenshot = vi.fn(async (_options?: unknown) => Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  waitForLoadState = vi.fn(async (_state?: string, _options?: unknown) => {});
  title = vi.fn(async () => 'Fixture');
  bringToFront = vi.fn();
  url() {
    return 'http://127.0.0.1:3000/';
  }
  asPage() {
    return this as unknown as Page;
  }
}

function fakeBrowser(page: FakePage | null) {
  const context = { pages: () => (page ? [page.asPage()] : []), setDefaultTimeout: vi.fn() };
  return { contexts: () => [context], context } as unknown as Browser & {
    context: typeof context;
  };
}

/** `AgentPages`: begins a call on a tab whose page is `guests[tabId]`. */
class FakeCalls {
  guests: Record<string, FakeGuest> = {};
  refusal: string | null = null;
  begun = 0;
  ended = 0;
  async beginToolCall(tabId: string): Promise<AgentCall> {
    if (this.refusal) throw new Error(this.refusal);
    const guest = this.guests[tabId];
    if (!guest) throw new Error('There is no such tab.');
    this.begun += 1;
    let done = false;
    return {
      guest: guest.asWebContents(),
      end: () => {
        if (done) return;
        done = true;
        this.ended += 1;
      },
    };
  }
}

let calls: FakeCalls;
let relays: FakeRelay[];
let page: FakePage;
let connect: ReturnType<typeof vi.fn<(relay: DriverRelay) => Promise<Browser>>>;
let now: number;
let driver: PageDriver;
let guest: FakeGuest;

beforeEach(() => {
  calls = new FakeCalls();
  relays = [];
  page = new FakePage();
  now = T0 + 60_000;
  connect = vi.fn(async (_relay: DriverRelay) => fakeBrowser(page));
  driver = new PageDriver({
    calls,
    openRelay: (relayGuest, options) => {
      const fake = relayGuest as unknown as FakeGuest;
      if (fake.devToolsOpen) throw new Error(DEVTOOLS_OPEN_MESSAGE);
      const relay = new FakeRelay(fake, options);
      relays.push(relay);
      return relay;
    },
    connect,
    now: () => now,
  });
  guest = new FakeGuest(1);
  calls.guests.tab1 = guest;
});

const listening = (target: FakeGuest) => target.debugger.listenerCount('message');

describe('connecting', () => {
  it('connects on first use, over a relay on the tab’s page, and reuses it', async () => {
    const seen: Page[] = [];
    await driver.withPage('tab1', async (p) => {
      seen.push(p);
    });
    await driver.withPage('tab1', async (p) => {
      seen.push(p);
    });
    expect(relays).toHaveLength(1);
    expect(relays[0].guest).toBe(guest);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(relays[0]);
    expect(seen).toEqual([page.asPage(), page.asPage()]);
    expect(calls.ended).toBe(2);
  });

  it('shares one connection between calls that overlap', async () => {
    let resolve!: (browser: Browser) => void;
    connect.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const first = driver.withPage('tab1', async () => 'a');
    const second = driver.withPage('tab1', async () => 'b');
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    resolve(fakeBrowser(page));
    expect(await Promise.all([first, second])).toEqual(['a', 'b']);
    expect(relays).toHaveLength(1);
  });

  it('ends the call when the work throws, and keeps the connection', async () => {
    await expect(
      driver.withPage('tab1', async () => {
        throw new Error('element not found');
      }),
    ).rejects.toThrow('element not found');
    expect(calls.ended).toBe(1);
    expect(relays[0].isClosed).toBe(false);
  });

  it('a call refused before it starts touches nothing', async () => {
    calls.refusal = 'Open this workspace in a window to use its browser.';
    await expect(driver.withPage('tab1', async () => {})).rejects.toThrow(
      'Open this workspace in a window to use its browser.',
    );
    expect(relays).toHaveLength(0);
  });

  it('a failed connect closes its relay, says why, and the next call tries again', async () => {
    connect.mockRejectedValueOnce(new Error('connectOverCDP: Timeout 15000ms exceeded.'));
    await expect(driver.withPage('tab1', async () => {})).rejects.toThrow('Timeout 15000ms');
    expect(relays[0].isClosed).toBe(true);
    expect(listening(guest)).toBe(0);
    expect(calls.ended).toBe(1);
    await driver.withPage('tab1', async () => {});
    expect(relays).toHaveLength(2);
  });

  it('a browser with no page is closed and refused', async () => {
    connect.mockResolvedValueOnce(fakeBrowser(null));
    await expect(driver.withPage('tab1', async () => {})).rejects.toThrow(
      "Could not reach the tab's page.",
    );
    expect(relays[0].isClosed).toBe(true);
  });

  it('gives each call a bound on how long Playwright waits', async () => {
    const browser = fakeBrowser(page);
    connect.mockResolvedValueOnce(browser);
    await driver.withPage('tab1', async () => {});
    expect(browser.context.setDefaultTimeout).toHaveBeenCalledWith(expect.any(Number));
  });

  it('hands the call main’s focus emulation switch, on the same relay', async () => {
    await driver.withPage('tab1', async (_page, control) => {
      await control.setFocusEmulation(true);
      await control.setFocusEmulation(false);
    });
    expect(relays[0].focus).toEqual([true, false]);
  });
});

describe('letting go', () => {
  it('closes the connection when the tab’s page goes, and stops listening to it', async () => {
    await driver.withPage('tab1', async () => {});
    expect(listening(guest)).toBe(1);
    driver.forget('tab1');
    expect(relays[0].isClosed).toBe(true);
    expect(listening(guest)).toBe(0);
    await driver.withPage('tab1', async () => {});
    expect(relays).toHaveLength(2);
  });

  it('replaces the connection when the tab has a new page', async () => {
    await driver.withPage('tab1', async () => {});
    const next = new FakeGuest(2);
    calls.guests.tab1 = next;
    await driver.withPage('tab1', async () => {});
    expect(relays[0].isClosed).toBe(true);
    expect(listening(guest)).toBe(0);
    expect(relays[1].guest).toBe(next);
  });

  it('closes every connection when the app quits', async () => {
    calls.guests.tab2 = new FakeGuest(2);
    await driver.withPage('tab1', async () => {});
    await driver.withPage('tab2', async () => {});
    driver.closeAll();
    expect(relays.map((relay) => relay.isClosed)).toEqual([true, true]);
  });

  it('forgetting a tab that is still connecting closes it and fails the call', async () => {
    let resolve!: (browser: Browser) => void;
    connect.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const pending = driver.withPage('tab1', async () => 'never');
    await vi.waitFor(() => expect(relays).toHaveLength(1));
    driver.forget('tab1');
    resolve(fakeBrowser(page));
    await expect(pending).rejects.toThrow("The tab's page went away.");
    expect(calls.ended).toBe(1);
  });
});

describe('DevTools', () => {
  it('refuses while DevTools is open on the tab, keeping nothing', async () => {
    guest.devToolsOpen = true;
    await expect(driver.withPage('tab1', async () => {})).rejects.toThrow(DEVTOOLS_OPEN_MESSAGE);
    expect(listening(guest)).toBe(0);
    expect(calls.ended).toBe(1);
    guest.devToolsOpen = false;
    await driver.withPage('tab1', async () => {});
    expect(relays).toHaveLength(1);
  });

  it('a call cut off by the person opening DevTools fails with that, and the next connects anew', async () => {
    await expect(
      driver.withPage('tab1', async () => {
        relays[0].close(DEVTOOLS_OPEN_MESSAGE);
        throw new Error('Target page, context or browser has been closed');
      }),
    ).rejects.toThrow(DEVTOOLS_OPEN_MESSAGE);
    expect(listening(guest)).toBe(0);
    await driver.withPage('tab1', async () => {});
    expect(relays).toHaveLength(2);
  });
});

describe('snapshot', () => {
  it('reads the page’s outline with refs, its address and title, and no image unless asked', async () => {
    const snapshot = await driver.snapshot('tab1');
    expect(page.ariaSnapshot).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ai' }));
    expect(snapshot).toMatchObject({
      url: 'http://127.0.0.1:3000/',
      title: 'Fixture',
      outline: '- heading "Fixture" [level=1] [ref=e1]',
      consoleErrors: [],
      failedRequests: [],
      dropped: { consoleErrors: 0, failedRequests: 0 },
    });
    expect(snapshot.png).toBeUndefined();
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(calls.ended).toBe(1);
  });

  it('adds a PNG when asked, taken without bringing anything to the front', async () => {
    const snapshot = await driver.snapshot('tab1', { screenshot: true });
    expect(snapshot.png?.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' }));
    expect(page.bringToFront).not.toHaveBeenCalled();
  });

  it('a screenshot that fails still answers with the outline, saying why', async () => {
    page.screenshot.mockRejectedValueOnce(new Error('page.screenshot: Timeout 10000ms exceeded.'));
    const snapshot = await driver.snapshot('tab1', { screenshot: true });
    expect(snapshot.outline).toContain('[ref=e1]');
    expect(snapshot.png).toBeUndefined();
    expect(snapshot.screenshotError).toContain('Timeout 10000ms exceeded');
  });

  it('reports console errors and failed requests since the last snapshot, including what happened before connecting', async () => {
    let resolve!: (browser: Browser) => void;
    connect.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const first = driver.snapshot('tab1');
    await vi.waitFor(() => expect(relays).toHaveLength(1));
    // Enabling the page's domains replays what it logged before anyone connected.
    guest.debugger.consoleError('logged at load', T0 + 1);
    guest.debugger.failedRequest('http://127.0.0.1:3000/missing.png', T0 + 2);
    guest.debugger.event('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'not an error' }],
      timestamp: T0 + 3,
    });
    resolve(fakeBrowser(page));
    const snapshot = await first;
    expect(snapshot.consoleErrors).toEqual([{ text: 'logged at load', at: T0 + 1 }]);
    expect(snapshot.failedRequests).toEqual([
      { url: 'http://127.0.0.1:3000/missing.png', reason: 'Failed to load resource', at: T0 + 2 },
    ]);

    guest.debugger.consoleError('later', T0 + 10);
    const second = await driver.snapshot('tab1');
    expect(second.consoleErrors.map((e) => e.text)).toEqual(['later']);
    expect(second.failedRequests).toEqual([]);
    expect((await driver.snapshot('tab1')).consoleErrors).toEqual([]);
  });

  it('keeps at most 200 console errors and 100 failed requests, counting the rest', async () => {
    await driver.withPage('tab1', async () => {});
    for (let i = 0; i < CONSOLE_ERRORS_KEPT + 50; i++) guest.debugger.consoleError(`e${i}`, T0 + i);
    for (let i = 0; i < FAILED_REQUESTS_KEPT + 30; i++) {
      guest.debugger.failedRequest(`http://a/${i}`, T0 + i);
    }
    const snapshot = await driver.snapshot('tab1');
    expect(CONSOLE_ERRORS_KEPT).toBe(200);
    expect(FAILED_REQUESTS_KEPT).toBe(100);
    expect(snapshot.consoleErrors).toHaveLength(200);
    expect(snapshot.consoleErrors[0].text).toBe('e50');
    expect(snapshot.failedRequests).toHaveLength(100);
    expect(snapshot.failedRequests[0].url).toBe('http://a/30');
    expect(snapshot.dropped).toEqual({ consoleErrors: 50, failedRequests: 30 });
  });

  it('a reconnect’s replay does not report again what a snapshot already did', async () => {
    await driver.withPage('tab1', async () => {});
    guest.debugger.consoleError('reported once', T0 + 1);
    expect((await driver.snapshot('tab1')).consoleErrors).toHaveLength(1);

    relays[0].close(DEVTOOLS_OPEN_MESSAGE);
    guest.debugger.consoleError('while nobody listened', T0 + 5);
    // The next connection's replay: both are still in the page's console.
    connect.mockImplementationOnce(async () => {
      guest.debugger.consoleError('reported once', T0 + 1);
      guest.debugger.consoleError('while nobody listened', T0 + 5);
      return fakeBrowser(page);
    });
    const snapshot = await driver.snapshot('tab1');
    expect(snapshot.consoleErrors.map((e) => e.text)).toEqual(['while nobody listened']);
  });

  it('a new page for the tab starts its report afresh', async () => {
    await driver.withPage('tab1', async () => {});
    guest.debugger.consoleError('old page', T0 + 100);
    await driver.snapshot('tab1');
    driver.forget('tab1');
    const next = new FakeGuest(2);
    calls.guests.tab1 = next;
    await driver.withPage('tab1', async () => {});
    next.debugger.consoleError('new page, earlier clock', T0 + 50);
    expect((await driver.snapshot('tab1')).consoleErrors.map((e) => e.text)).toEqual([
      'new page, earlier clock',
    ]);
  });

  it('nothing is collected for a tab once its connection is gone', async () => {
    await driver.withPage('tab1', async () => {});
    driver.forget('tab1');
    guest.debugger.consoleError('after', T0 + 1);
    expect(listening(guest)).toBe(0);
  });
});

describe('logged objects', () => {
  const releases = (target: FakeGuest) =>
    target.debugger.sent.filter((c) => c.method === 'Runtime.releaseObjectGroup');

  it('lets the page free what it logged once a snapshot has read it, in each frame that logged', async () => {
    await driver.withPage('tab1', async () => {});
    guest.debugger.event('Runtime.consoleAPICalled', { type: 'log', args: [], timestamp: T0 });
    guest.debugger.consoleError('in a frame', T0, 'FRAME-SESSION');
    await driver.snapshot('tab1');
    expect(releases(guest)).toEqual([
      { method: 'Runtime.releaseObjectGroup', params: { objectGroup: 'console' } },
      {
        method: 'Runtime.releaseObjectGroup',
        params: { objectGroup: 'console' },
        sessionId: 'FRAME-SESSION',
      },
    ]);
    await driver.snapshot('tab1');
    expect(releases(guest)).toHaveLength(2);
  });

  it('frees them as it goes when nobody takes a snapshot', async () => {
    await driver.withPage('tab1', async () => {});
    for (let i = 0; i < RELEASE_CONSOLE_EVERY * 3; i++) {
      guest.debugger.event('Runtime.consoleAPICalled', { type: 'log', args: [], timestamp: T0 });
    }
    expect(releases(guest)).toHaveLength(3);
  });
});
