import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import type { Browser, Page } from 'playwright-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCall } from './AgentPages';
import type { CdpRelayOptions } from './CdpRelay';
import { DEVTOOLS_OPEN_MESSAGE } from './CdpRelay';
import {
  ANOTHER_CALL_PAST_DEADLINE_MESSAGE,
  CALL_DEADLINE_MS,
  clampDeadline,
  CONSOLE_ERRORS_KEPT,
  type DriverRelay,
  FAILED_REQUESTS_KEPT,
  MAX_CALL_DEADLINE_MS,
  PageDriver,
  pastDeadlineMessage,
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
  /** The title main reads from the page, without asking the page. */
  title = 'Fixture';
  constructor(public readonly id: number) {
    super();
  }
  getTitle() {
    return this.title;
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
  /** A page blocked by a dialog never answers the switch going off. */
  answersFocusOff = true;
  /** As a relay whose page went away mid-close might. */
  throwOnClose = false;
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
    if (this.throwOnClose) throw new Error('Object has been destroyed');
  }
  async setFocusEmulation(enabled: boolean) {
    if (this.isClosed) throw new Error('The relay is closed.');
    this.focus.push(enabled);
    if (!enabled && !this.answersFocusOff) await new Promise(() => {});
  }
}

class FakePage {
  outline = '- heading "Fixture" [level=1] [ref=e1]';
  ariaSnapshot = vi.fn(async (_options?: unknown) => this.outline);
  screenshot = vi.fn(async (_options?: unknown) => Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  waitForLoadState = vi.fn(async (_state?: string, _options?: unknown) => {});
  /** A round trip to the page, which Playwright does not bound: never answers here. */
  title = vi.fn(() => new Promise<string>(() => {}));
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

/** The timers the driver starts, fired by hand. */
class FakeTimers {
  readonly pending: Array<{ ms: number; fire: () => void }> = [];
  readonly start = (ms: number, fire: () => void): (() => void) => {
    const timer = { ms, fire };
    this.pending.push(timer);
    return () => {
      const at = this.pending.indexOf(timer);
      if (at >= 0) this.pending.splice(at, 1);
    };
  };
  /** Every timer still pending, as if its time had come. */
  fireAll() {
    for (const timer of this.pending.splice(0)) timer.fire();
  }
}

let calls: FakeCalls;
let relays: FakeRelay[];
let disconnected: WebContents[];
let page: FakePage;
let connect: ReturnType<typeof vi.fn<(relay: DriverRelay) => Promise<Browser>>>;
let now: number;
let timers: FakeTimers;
let driver: PageDriver;
let guest: FakeGuest;

beforeEach(() => {
  calls = new FakeCalls();
  relays = [];
  page = new FakePage();
  now = T0 + 60_000;
  timers = new FakeTimers();
  connect = vi.fn(async (_relay: DriverRelay) => fakeBrowser(page));
  disconnected = [];
  driver = new PageDriver({
    disconnected: (gone) => disconnected.push(gone),
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
    startTimer: timers.start,
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
    driver.forget('tab1', guest.asWebContents());
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

  it('a page that went is forgotten only while it is the one connected', async () => {
    await driver.withPage('tab1', async () => {});
    guest.debugger.consoleError('reported', T0 + 10);
    await driver.snapshot('tab1');
    // Late news of another page this tab once had changes nothing.
    driver.forget('tab1', new FakeGuest(2).asWebContents());
    expect(relays[0].isClosed).toBe(false);
    // The tab still knows what it reported, so a replay of it is not new.
    guest.debugger.consoleError('reported', T0 + 10);
    expect((await driver.snapshot('tab1')).consoleErrors).toEqual([]);

    driver.forget('tab1', guest.asWebContents());
    expect(relays[0].isClosed).toBe(true);
  });

  it('forgetting a tab that is still connecting closes it and fails the call', async () => {
    let resolve!: (browser: Browser) => void;
    connect.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const pending = driver.withPage('tab1', async () => 'never');
    await vi.waitFor(() => expect(relays).toHaveLength(1));
    driver.forget('tab1', guest.asWebContents());
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

describe('the deadline', () => {
  const pastDeadline = `did not finish within ${CALL_DEADLINE_MS / 1000} seconds`;
  const never = () => new Promise<never>(() => {});

  it('fails a call still running at its deadline, closes its connection, and lets go of the tab', async () => {
    const stuck = driver.withPage('tab1', never);
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    expect(timers.pending[0].ms).toBe(CALL_DEADLINE_MS);
    expect(calls.ended).toBe(0);

    timers.fireAll();
    await expect(stuck).rejects.toThrow(pastDeadline);
    // Closed, so no step still under way acts on a page its call let go of.
    expect(relays[0].isClosed).toBe(true);
    expect(listening(guest)).toBe(0);
    expect(calls.ended).toBe(1);
    await driver.withPage('tab1', async () => {});
    expect(relays).toHaveLength(2);
  });

  it('leaves nothing behind for a call that ends in time, however it ends', async () => {
    await driver.withPage('tab1', async () => 'done');
    await expect(
      driver.withPage('tab1', async () => {
        throw new Error('element not found');
      }),
    ).rejects.toThrow('element not found');
    expect(timers.pending).toEqual([]);
    expect(relays[0].isClosed).toBe(false);
  });

  it('allows a caller a longer call', async () => {
    const waiting = driver.withPage('tab1', never, { deadlineMs: 75_000 });
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    expect(timers.pending[0].ms).toBe(75_000);
    timers.fireAll();
    await expect(waiting).rejects.toThrow('did not finish within 75 seconds');
  });

  it('bounds a snapshot whose page stops answering', async () => {
    page.ariaSnapshot.mockImplementationOnce(never);
    const stuck = driver.snapshot('tab1');
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    timers.fireAll();
    await expect(stuck).rejects.toThrow(pastDeadline);
    expect(calls.ended).toBe(1);
  });

  it('closes only the connection its call used', async () => {
    const stuck = driver.withPage('tab1', never);
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    // The tab's page is replaced under the call, and another call connects to the new one.
    driver.forget('tab1', guest.asWebContents());
    const next = new FakeGuest(2);
    calls.guests.tab1 = next;
    const other = driver.withPage('tab1', never);
    await vi.waitFor(() => expect(relays).toHaveLength(2));

    await vi.waitFor(() => expect(timers.pending).toHaveLength(2));
    timers.pending[0].fire();
    // It fails with what happened to its page, the better explanation.
    await expect(stuck).rejects.toThrow("The tab's page went away.");
    expect(relays[1].isClosed).toBe(false);
    timers.fireAll();
    await expect(other).rejects.toThrow(pastDeadline);
  });

  it('a step that answers after its deadline changes nothing', async () => {
    await driver.withPage('tab1', async () => {});
    let answer!: (outline: string) => void;
    page.ariaSnapshot.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const stuck = driver.snapshot('tab1');
    await vi.waitFor(() => expect(page.ariaSnapshot).toHaveBeenCalled());
    guest.debugger.consoleError('never reported', T0 + 5);
    timers.fireAll();
    await expect(stuck).rejects.toThrow(pastDeadline);
    answer(page.outline);
    await new Promise((resolve) => setImmediate(resolve));

    // Nobody was told, so the next connection's replay still reports it.
    connect.mockImplementationOnce(async () => {
      guest.debugger.consoleError('never reported', T0 + 5);
      return fakeBrowser(page);
    });
    const next = await driver.snapshot('tab1');
    expect(next.consoleErrors.map((entry) => entry.text)).toEqual(['never reported']);
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

  it('reads the title from main, never waiting on the page for it', async () => {
    guest.title = 'Read by main';
    const snapshot = await driver.snapshot('tab1');
    expect(snapshot.title).toBe('Read by main');
    expect(page.title).not.toHaveBeenCalled();
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
    driver.forget('tab1', guest.asWebContents());
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
    driver.forget('tab1', guest.asWebContents());
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

describe('a deadline is a sane length', () => {
  it('clamps what a caller asks for to a finite range', () => {
    expect(clampDeadline(undefined)).toBe(CALL_DEADLINE_MS);
    expect(clampDeadline(Number.NaN)).toBe(CALL_DEADLINE_MS);
    expect(clampDeadline(Number.POSITIVE_INFINITY)).toBe(MAX_CALL_DEADLINE_MS);
    // Past 2^31 - 1 ms, Node's setTimeout fires after 1 ms.
    expect(clampDeadline(2 ** 40)).toBe(MAX_CALL_DEADLINE_MS);
    expect(clampDeadline(0)).toBe(1);
    expect(clampDeadline(-5)).toBe(1);
    expect(clampDeadline(70_000)).toBe(70_000);
    expect(MAX_CALL_DEADLINE_MS).toBeLessThan(2 ** 31 - 1);
  });

  it('starts the timer at the clamped length', async () => {
    const never = () => new Promise<never>(() => {});
    void driver.withPage('tab1', never, { deadlineMs: Number.POSITIVE_INFINITY }).catch(() => {});
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    expect(timers.pending[0].ms).toBe(MAX_CALL_DEADLINE_MS);
  });
});

describe('a call given up on', () => {
  const never = () => new Promise<never>(() => {});

  it('still fails, and lets go of the tab, when closing its connection throws', async () => {
    const stuck = driver.withPage('tab1', never);
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    relays[0].throwOnClose = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => timers.fireAll()).not.toThrow();
    await expect(stuck).rejects.toThrow(pastDeadlineMessage(CALL_DEADLINE_MS));
    expect(calls.ended).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is told by its signal, so a step it has not started yet never runs', async () => {
    let signal: AbortSignal | undefined;
    let stepAfterDeadline = false;
    let resume!: () => void;
    const stuck = driver.withPage('tab1', async (_page, control) => {
      signal = control.signal;
      await new Promise<void>((resolve) => (resume = resolve));
      if (control.signal.aborted) return;
      stepAfterDeadline = true;
    });
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    expect(signal?.aborted).toBe(false);
    timers.fireAll();
    await expect(stuck).rejects.toThrow(pastDeadlineMessage(CALL_DEADLINE_MS));
    expect(signal?.aborted).toBe(true);
    resume();
    await new Promise((resolve) => setImmediate(resolve));
    expect(stepAfterDeadline).toBe(false);
  });

  it('is told by its signal when its page goes, and once it has ended', async () => {
    let during: AbortSignal | undefined;
    const pending = driver.withPage('tab1', async (_page, control) => {
      during = control.signal;
      await new Promise((resolve) => setImmediate(resolve));
      driver.forget('tab1', guest.asWebContents());
      expect(control.signal.aborted).toBe(true);
    });
    await pending;
    let ended: AbortSignal | undefined;
    await driver.withPage('tab1', async (_page, control) => {
      ended = control.signal;
    });
    expect(during?.aborted).toBe(true);
    expect(ended?.aborted).toBe(true);
  });

  it('fails with its own deadline, while a call it cut short is told it was another call’s', async () => {
    const own = driver.withPage('tab1', never, { deadlineMs: 5_000 });
    // Cut short when the connection closes, as Playwright's steps are.
    const other = driver.withPage('tab1', (_page, control) => {
      return new Promise<never>((_resolve, reject) => {
        control.signal.addEventListener('abort', () =>
          reject(new Error('Target page, context or browser has been closed')),
        );
      });
    });
    await vi.waitFor(() => expect(timers.pending).toHaveLength(2));
    timers.pending.find((timer) => timer.ms === 5_000)?.fire();
    await expect(own).rejects.toThrow(pastDeadlineMessage(5_000));
    await expect(other).rejects.toThrow(ANOTHER_CALL_PAST_DEADLINE_MESSAGE);
  });
});

describe('focus emulation', () => {
  it('is turned off by the driver when a call leaves it on, however the call ends', async () => {
    await driver.withPage('tab1', async (_page, control) => {
      await control.setFocusEmulation(true);
    });
    expect(relays[0].focus).toEqual([true, false]);

    await expect(
      driver.withPage('tab1', async (_page, control) => {
        await control.setFocusEmulation(true);
        throw new Error('element not found');
      }),
    ).rejects.toThrow('element not found');
    expect(relays[0].focus).toEqual([true, false, true, false]);
  });

  it('stays on while any overlapping call wants it', async () => {
    let finishFirst!: () => void;
    const first = driver.withPage('tab1', async (_page, control) => {
      await control.setFocusEmulation(true);
      await new Promise<void>((resolve) => (finishFirst = resolve));
    });
    await vi.waitFor(() => expect(relays[0]?.focus).toEqual([true]));
    let finishSecond!: () => void;
    const second = driver.withPage('tab1', async (_page, control) => {
      await control.setFocusEmulation(true);
      await new Promise<void>((resolve) => (finishSecond = resolve));
    });
    await vi.waitFor(() => expect(finishSecond).toBeDefined());
    finishFirst();
    await first;
    expect(relays[0].focus).toEqual([true]);
    finishSecond();
    await second;
    expect(relays[0].focus).toEqual([true, false]);
  });

  it('never holds a call open waiting for the page to answer the switch going off', async () => {
    await driver.withPage('tab1', async () => {});
    relays[0].answersFocusOff = false;
    await driver.withPage('tab1', async (_page, control) => {
      await control.setFocusEmulation(true);
    });
    expect(relays[0].focus).toEqual([true, false]);
    expect(calls.ended).toBe(2);
  });

  it('is left alone on a connection a deadline closed, since detaching ends it', async () => {
    const stuck = driver.withPage('tab1', async (_page, control) => {
      await control.setFocusEmulation(true);
      await new Promise<never>(() => {});
    });
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    timers.fireAll();
    await expect(stuck).rejects.toThrow(pastDeadlineMessage(CALL_DEADLINE_MS));
    expect(relays[0].focus).toEqual([true]);
  });
});

describe('who is connected', () => {
  it('knows which pages an agent connection is open on, and says when one ends', async () => {
    expect(driver.isConnected(guest.asWebContents())).toBe(false);
    await driver.withPage('tab1', async () => {});
    expect(driver.isConnected(guest.asWebContents())).toBe(true);
    expect(driver.isConnected(new FakeGuest(9).asWebContents())).toBe(false);
    driver.forget('tab1', guest.asWebContents());
    expect(driver.isConnected(guest.asWebContents())).toBe(false);
    expect(disconnected).toEqual([guest.asWebContents()]);
  });
});
