import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpRelay, type CdpRelayOptions, DEVTOOLS_OPEN_MESSAGE, type RelayGuest } from './CdpRelay';
import { PAGE_SESSION_ID } from './cdpRelayProtocol';

type Message = Record<string, unknown>;

/** A stand-in for `webContents.debugger`: one page, answering every command with `{}`. */
class FakeDebugger extends EventEmitter {
  attached = false;
  attachedWith: string | undefined;
  detachCalls = 0;
  attachError: string | undefined;
  readonly commands: Array<{ method: string; params: unknown; sessionId?: string }> = [];
  answer: (method: string, params: unknown) => Promise<unknown> = async () => ({});

  attach(version?: string) {
    if (this.attachError) throw new Error(this.attachError);
    this.attached = true;
    this.attachedWith = version;
  }

  detach() {
    this.attached = false;
    this.detachCalls += 1;
  }

  isAttached() {
    return this.attached;
  }

  sendCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    if (!this.attached) return Promise.reject(new Error('Debugger is not attached'));
    if (method === 'Target.getTargetInfo') {
      return Promise.resolve({
        targetInfo: { targetId: 'GUEST-TARGET', type: 'webview', url: 'http://x/', title: 'X' },
      });
    }
    this.commands.push(
      sessionId === undefined ? { method, params } : { method, params, sessionId },
    );
    return this.answer(method, params);
  }

  /** What Electron emits for a page event; `sessionId` is empty for the page itself. */
  emitEvent(method: string, params: unknown, sessionId = '') {
    this.emit('message', {}, method, params, sessionId);
  }
}

const relays: CdpRelay[] = [];
afterEach(() => {
  for (const relay of relays.splice(0)) relay.close();
});

/** A stand-in for the guest's `WebContents`. */
class FakeGuest extends EventEmitter {
  devToolsOpen = false;
  readonly debugger: FakeDebugger;
  constructor(pageDebugger: FakeDebugger) {
    super();
    this.debugger = pageDebugger;
  }
  getUserAgent() {
    return 'Mozilla/5.0 Consola';
  }
  isDevToolsOpened() {
    return this.devToolsOpen;
  }
}

const guestOf = (fake: FakeDebugger) => new FakeGuest(fake) as unknown as RelayGuest & FakeGuest;

/** A relay with Playwright's side played by the test, as CRConnection wires a transport. */
function open(options: CdpRelayOptions = {}) {
  const fake = new FakeDebugger();
  const guest = guestOf(fake);
  const onClose = vi.fn();
  const relay = CdpRelay.open(guest, { onClose, ...options });
  relays.push(relay);
  const received: Message[] = [];
  const onclose = vi.fn();
  relay.onmessage = (message) => received.push(message as Message);
  relay.onclose = onclose;
  const until = async (match: (message: Message) => boolean): Promise<Message> => {
    await vi.waitFor(() => expect(received.find(match)).toBeDefined());
    return received.find(match) as Message;
  };
  const call = (id: number, method: string, params?: Message, sessionId?: string) => {
    relay.send(
      sessionId === undefined ? { id, method, params } : { id, method, params, sessionId },
    );
    return until((message) => message.id === id);
  };
  const announce = async () => {
    await call(1, 'Target.setAutoAttach', { autoAttach: true, flatten: true });
    await until((message) => message.method === 'Target.attachedToTarget');
  };
  return { fake, guest, relay, onClose, onclose, received, until, call, announce };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('CdpRelay as Playwright’s transport', () => {
  it('attaches to the page’s debugger, at protocol 1.3', () => {
    const { fake } = open();
    expect(fake.attached).toBe(true);
    expect(fake.attachedWith).toBe('1.3');
  });

  it('answers through onmessage, never inside send', async () => {
    const { relay, received } = open();
    relay.send({ id: 1, method: 'Browser.getVersion' });
    expect(received).toEqual([]);
    await settle();
    expect(received).toEqual([
      { id: 1, result: expect.objectContaining({ userAgent: 'Mozilla/5.0 Consola' }) },
    ]);
  });

  it('announces the page under its real target id, as a page', async () => {
    const { call, until } = open();
    await call(1, 'Target.setAutoAttach', { autoAttach: true, flatten: true });
    expect(await until((message) => message.method === 'Target.attachedToTarget')).toEqual({
      method: 'Target.attachedToTarget',
      params: expect.objectContaining({
        sessionId: PAGE_SESSION_ID,
        targetInfo: expect.objectContaining({ targetId: 'GUEST-TARGET', type: 'page' }),
      }),
    });
  });

  it('forwards a page command to the debugger and routes the answer back', async () => {
    const { fake, call, announce } = open();
    fake.answer = async () => ({ result: { type: 'number', value: 2 } });
    await announce();
    const reply = await call(2, 'Runtime.evaluate', { expression: '1+1' }, PAGE_SESSION_ID);
    expect(reply).toEqual({
      id: 2,
      result: { result: { type: 'number', value: 2 } },
      sessionId: PAGE_SESSION_ID,
    });
    // With its user gesture taken off (Ruling MM).
    expect(fake.commands).toEqual([
      { method: 'Runtime.evaluate', params: { expression: '1+1', userGesture: false } },
    ]);
  });

  it('refuses a new page, or any other unknown browser-level command, with a CDP error', async () => {
    const { fake, call } = open();
    expect(await call(1, 'Target.createTarget', { url: 'about:blank' })).toEqual({
      id: 1,
      error: { code: -32000, message: expect.stringContaining('Target.createTarget') },
    });
    expect(await call(2, 'Storage.getCookies', {})).toHaveProperty('error');
    expect(fake.commands).toEqual([]);
  });

  it('swallows Playwright’s focus emulation, while main can still set it itself', async () => {
    const { relay, fake, call, announce } = open();
    await announce();
    const reply = await call(
      2,
      'Emulation.setFocusEmulationEnabled',
      { enabled: true },
      PAGE_SESSION_ID,
    );
    expect(reply).toEqual({ id: 2, result: {}, sessionId: PAGE_SESSION_ID });
    expect(fake.commands).toEqual([]);
    await relay.setFocusEmulation(true);
    await relay.setFocusEmulation(false);
    expect(fake.commands).toEqual([
      { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } },
      { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } },
    ]);
  });

  it('delivers the debugger’s events, under the page session or the child’s own', async () => {
    const { fake, announce, until } = open();
    await announce();
    fake.emitEvent('Target.attachedToTarget', {
      sessionId: 'IFRAME-SESSION',
      targetInfo: { targetId: 'IFRAME', type: 'iframe' },
      waitingForDebugger: true,
    });
    fake.emitEvent('Page.loadEventFired', { timestamp: 1 });
    fake.emitEvent('Runtime.executionContextCreated', { context: { id: 2 } }, 'IFRAME-SESSION');
    expect(await until((message) => message.method === 'Page.loadEventFired')).toEqual({
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
      sessionId: PAGE_SESSION_ID,
    });
    expect(
      await until((message) => message.method === 'Runtime.executionContextCreated'),
    ).toHaveProperty('sessionId', 'IFRAME-SESSION');
  });

  // The reviewer's escape.js and files.js probes, against the fake: none of
  // these may reach the debugger from the page's own session.
  it('keeps the page’s session to the page: no other target, no downloads, no files', async () => {
    const { fake, call, announce } = open();
    await announce();
    const attempts: Array<[string, Message]> = [
      ['Target.getTargets', {}],
      ['Target.attachToTarget', { targetId: 'HOST-WINDOW', flatten: true }],
      ['Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp/anywhere' }],
      ['DOM.setFileInputFiles', { files: ['/etc/hosts'], nodeId: 7 }],
      ['Page.navigate', { url: 'file:///etc/hosts' }],
      ['Page.bringToFront', {}],
    ];
    let id = 10;
    for (const [method, params] of attempts) {
      expect(await call(id++, method, params, PAGE_SESSION_ID)).toHaveProperty('error');
    }
    // Answered by the relay itself, so it changes nothing either.
    const downloads = await call(
      id++,
      'Browser.setDownloadBehavior',
      {
        behavior: 'allow',
        downloadPath: '/tmp/anywhere',
      },
      PAGE_SESSION_ID,
    );
    expect(downloads).toHaveProperty('result', {});
    // A session id the page never announced gets nowhere.
    expect(
      await call(id++, 'Runtime.evaluate', { expression: '1' }, 'HOST-SESSION'),
    ).toHaveProperty('error');
    expect(fake.commands).toEqual([]);
  });
});

describe('CdpRelay lifetime', () => {
  it('surfaces a failed attach and leaves nothing behind', () => {
    const fake = new FakeDebugger();
    fake.attachError = 'Another debugger is already attached to this target';
    expect(() => CdpRelay.open(guestOf(fake))).toThrow(
      'Could not attach to the page: Another debugger is already attached to this target',
    );
    expect(fake.listenerCount('message')).toBe(0);
    expect(fake.listenerCount('detach')).toBe(0);
  });

  it('refuses a page whose debugger something else already holds, leaving it attached', () => {
    const fake = new FakeDebugger();
    fake.attached = true;
    expect(() => CdpRelay.open(guestOf(fake))).toThrow(/already in use/);
    expect(fake.detachCalls).toBe(0);
  });

  // Electron 43 lets DevTools and the debugger share a guest, so the relay
  // has to step aside on its own: the person comes first.
  it('will not open while DevTools is open on the page', () => {
    const fake = new FakeDebugger();
    const guest = guestOf(fake);
    guest.devToolsOpen = true;
    expect(() => CdpRelay.open(guest)).toThrow(DEVTOOLS_OPEN_MESSAGE);
    expect(fake.attached).toBe(false);
    expect(guest.listenerCount('devtools-opened')).toBe(0);
  });

  it('closes when the person opens DevTools on the page', () => {
    const { relay, guest, fake, onclose, onClose } = open();
    guest.emit('devtools-opened');
    expect(relay.isClosed).toBe(true);
    expect(fake.detachCalls).toBe(1);
    expect(onclose).toHaveBeenCalledWith(DEVTOOLS_OPEN_MESSAGE);
    expect(onClose).toHaveBeenCalledWith(DEVTOOLS_OPEN_MESSAGE);
  });

  it('close() detaches once and tells Playwright and main, once', async () => {
    const { relay, guest, fake, onClose, onclose, received } = open();
    relay.close('The tab was closed.');
    relay.close();
    expect(fake.detachCalls).toBe(1);
    expect(fake.listenerCount('message')).toBe(0);
    expect(fake.listenerCount('detach')).toBe(0);
    expect(guest.listenerCount('devtools-opened')).toBe(0);
    expect(onclose).toHaveBeenCalledExactlyOnceWith('The tab was closed.');
    expect(onClose).toHaveBeenCalledExactlyOnceWith('The tab was closed.');
    expect(relay.isClosed).toBe(true);
    relay.send({ id: 9, method: 'Browser.getVersion' });
    await settle();
    expect(received).toEqual([]);
    await expect(relay.setFocusEmulation(true)).rejects.toThrow(/closed/);
  });

  it('tells main before Playwright, and one listener failing does not silence the other', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order: string[] = [];
    const fake = new FakeDebugger();
    const relay = CdpRelay.open(guestOf(fake), {
      onClose: () => {
        order.push('main');
        throw new Error('main failed');
      },
    });
    relay.onclose = () => {
      order.push('playwright');
      throw new Error('playwright failed');
    };
    expect(() => relay.close('The tab was closed.')).not.toThrow();
    expect(order).toEqual(['main', 'playwright']);
    expect(fake.detachCalls).toBe(1);
    warn.mockRestore();
  });

  it('drops answers still in flight when it closes', async () => {
    const { relay, fake, received, announce } = open();
    await announce();
    received.length = 0;
    let finish: (value: unknown) => void = () => {};
    fake.answer = () => new Promise((resolve) => (finish = resolve));
    relay.send({ id: 2, method: 'DOM.getDocument', params: {}, sessionId: PAGE_SESSION_ID });
    await settle();
    relay.close();
    finish({ root: {} });
    await settle();
    expect(received).toEqual([]);
  });

  // `webContents.debugger` is shared: once Chromium has ended the relay's
  // attachment, a detach from the relay could only end someone else's.
  it('closes when the debugger detaches on its own, without detaching it again', () => {
    const { relay, fake, onclose, onClose } = open();
    fake.emit('detach', {}, 'Replaced by DevTools');
    expect(relay.isClosed).toBe(true);
    expect(fake.detachCalls).toBe(0);
    expect(onclose).toHaveBeenCalledWith(expect.stringContaining('Replaced by DevTools'));
    expect(onClose).toHaveBeenCalledWith(expect.stringContaining('Replaced by DevTools'));
  });

  it('closes, rather than letting callbacks pile up, when the page stops answering', async () => {
    const { relay, fake, onclose, announce } = open({ maxCommandsInFlight: 3 });
    await announce();
    fake.answer = () => new Promise(() => {});
    for (let id = 10; id < 13; id++) {
      relay.send({ id, method: 'Runtime.releaseObject', params: {}, sessionId: PAGE_SESSION_ID });
    }
    expect(relay.isClosed).toBe(false);
    relay.send({ id: 13, method: 'Runtime.releaseObject', params: {}, sessionId: PAGE_SESSION_ID });
    expect(relay.isClosed).toBe(true);
    expect(fake.detachCalls).toBe(1);
    expect(onclose).toHaveBeenCalledWith(expect.stringContaining('stopped answering'));
  });
});
