import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { CdpRelay, type RelayGuest, refuseUpgrade } from './CdpRelay';
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
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const relay of relays.splice(0)) relay.close();
});

async function open(options: Parameters<typeof CdpRelay.open>[1] = {}) {
  const fake = new FakeDebugger();
  const guest = { debugger: fake, getUserAgent: () => 'Mozilla/5.0 Consola' };
  const onClose = vi.fn();
  const relay = await CdpRelay.open(guest as unknown as RelayGuest, { onClose, ...options });
  relays.push(relay);
  return { fake, relay, onClose, url: new URL(relay.endpoint) };
}

/** Tries a WebSocket upgrade: 'open', or the HTTP status it was refused with. */
function attempt(endpoint: string, headers: Record<string, string> = {}): Promise<'open' | number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, { headers });
    sockets.push(socket);
    socket.on('open', () => resolve('open'));
    socket.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
    socket.on('error', reject);
  });
}

/** A connected client that collects what the relay writes. */
async function connect(endpoint: string) {
  const socket = new WebSocket(endpoint);
  sockets.push(socket);
  const received: Message[] = [];
  const waiters: Array<() => void> = [];
  socket.on('message', (data) => {
    received.push(JSON.parse(String(data)));
    for (const wake of waiters.splice(0)) wake();
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const until = async (match: (message: Message) => boolean): Promise<Message> => {
    for (;;) {
      const found = received.find(match);
      if (found) return found;
      await new Promise<void>((wake) => waiters.push(wake));
    }
  };
  const send = (message: Message) => socket.send(JSON.stringify(message));
  const call = (id: number, method: string, params?: Message, sessionId?: string) => {
    send({ id, method, params, sessionId });
    return until((message) => message.id === id);
  };
  return { socket, received, until, call };
}

const closedOnce = (socket: WebSocket) =>
  new Promise<void>((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) resolve();
    else socket.once('close', () => resolve());
  });

describe('CdpRelay endpoint', () => {
  it('attaches to the page and listens on loopback, at a path holding 24 random bytes', async () => {
    const { fake, relay } = await open();
    const other = await open();
    expect(fake.attachedWith).toBe('1.3');
    expect(relay.endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}$/);
    expect(new URL(other.relay.endpoint).pathname).not.toBe(new URL(relay.endpoint).pathname);
  });

  it('refuses a wrong path', async () => {
    const { url, fake, relay } = await open();
    const secret = url.pathname;
    for (const path of [
      '/',
      secret.slice(0, -1),
      `${secret}/x`,
      `${secret}?x=1`,
      '/json/version',
    ]) {
      expect(await attempt(`ws://${url.host}${path}`)).toBe(404);
    }
    expect(fake.commands).toEqual([]);
    expect(relay.isClosed).toBe(false);
  });

  it('refuses a request with an Origin header, even on the right path', async () => {
    const { relay } = await open();
    expect(await attempt(relay.endpoint, { Origin: 'http://127.0.0.1:3000' })).toBe(403);
    expect(await attempt(relay.endpoint, { Origin: 'null' })).toBe(403);
    expect(await attempt(relay.endpoint)).toBe('open');
  });

  it('refuses a Host that is not loopback on this port', async () => {
    const { relay, url } = await open();
    for (const host of [
      `evil.example:${url.port}`,
      `127.0.0.1.evil.example:${url.port}`,
      `127.0.0.1:${Number(url.port) + 1}`,
      '127.0.0.1',
    ]) {
      expect(await attempt(relay.endpoint, { Host: host })).toBe(403);
    }
    expect(await attempt(relay.endpoint, { Host: `localhost:${url.port}` })).toBe('open');
  });

  it('answers plain HTTP with nothing, the secret path included', async () => {
    const { relay, url } = await open();
    const httpBase = `http://${url.host}`;
    expect((await fetch(`${httpBase}/json/version`)).status).toBe(404);
    expect((await fetch(`${httpBase}${url.pathname}`)).status).toBe(404);
    expect(relay.isClosed).toBe(false);
  });

  it('serves one client: a second is refused while the first is connected', async () => {
    const { relay } = await open();
    await connect(relay.endpoint);
    expect(await attempt(relay.endpoint)).toBe(409);
  });
});

describe('refuseUpgrade', () => {
  const expected = { path: '/secret', port: 4000 };
  const request = (url: string, headers: Record<string, string>) => ({ url, headers });

  it('lets through only the secret path, from loopback, with no Origin', () => {
    expect(refuseUpgrade(request('/secret', { host: '127.0.0.1:4000' }), expected)).toBeUndefined();
    expect(refuseUpgrade(request('/secret', { host: 'LOCALHOST:4000' }), expected)).toBeUndefined();
    expect(refuseUpgrade(request('/secret', { host: '[::1]:4000' }), expected)).toBeUndefined();
    expect(refuseUpgrade(request('/secrets', { host: '127.0.0.1:4000' }), expected)).toBe(404);
    expect(refuseUpgrade(request('/secret', {}), expected)).toBe(403);
    expect(refuseUpgrade(request('/secret', { host: '0.0.0.0:4000' }), expected)).toBe(403);
    expect(
      refuseUpgrade(request('/secret', { host: '127.0.0.1:4000', origin: '' }), expected),
    ).toBe(403);
    expect(
      refuseUpgrade(
        request('/secret', { host: '127.0.0.1:4000', 'sec-websocket-origin': 'http://a' }),
        expected,
      ),
    ).toBe(403);
  });
});

describe('CdpRelay traffic', () => {
  it('forwards a page command to the debugger and routes the answer back', async () => {
    const { relay, fake } = await open();
    fake.answer = async (method) => ({ result: { type: 'number', value: 2 }, method });
    const client = await connect(relay.endpoint);
    await client.call(1, 'Target.setAutoAttach', { autoAttach: true, flatten: true });
    await client.until((message) => message.method === 'Target.attachedToTarget');
    const reply = await client.call(2, 'Runtime.evaluate', { expression: '1+1' }, PAGE_SESSION_ID);
    expect(reply).toEqual({
      id: 2,
      result: { result: { type: 'number', value: 2 }, method: 'Runtime.evaluate' },
      sessionId: PAGE_SESSION_ID,
    });
    expect(fake.commands).toEqual([{ method: 'Runtime.evaluate', params: { expression: '1+1' } }]);
  });

  it('refuses an unknown browser-level command with a CDP error', async () => {
    const { relay, fake } = await open();
    const client = await connect(relay.endpoint);
    const reply = await client.call(1, 'Target.createTarget', { url: 'https://example.com' });
    expect(reply).toEqual({
      id: 1,
      error: { code: -32000, message: expect.stringContaining('Target.createTarget') },
    });
    expect(fake.commands).toEqual([]);
  });

  it('swallows focus emulation instead of passing it to the page', async () => {
    const { relay, fake } = await open();
    const client = await connect(relay.endpoint);
    await client.call(1, 'Target.setAutoAttach', { autoAttach: true, flatten: true });
    const reply = await client.call(
      2,
      'Emulation.setFocusEmulationEnabled',
      { enabled: true },
      PAGE_SESSION_ID,
    );
    expect(reply).toEqual({ id: 2, result: {}, sessionId: PAGE_SESSION_ID });
    expect(fake.commands).toEqual([]);
  });

  it('delivers the debugger’s events, under the page session or the child’s own', async () => {
    const { relay, fake } = await open();
    const client = await connect(relay.endpoint);
    await client.call(1, 'Target.setAutoAttach', { autoAttach: true, flatten: true });
    await client.until((message) => message.method === 'Target.attachedToTarget');
    fake.emitEvent('Page.loadEventFired', { timestamp: 1 });
    fake.emitEvent('Runtime.consoleAPICalled', { type: 'log' }, 'IFRAME-SESSION');
    expect(await client.until((message) => message.method === 'Page.loadEventFired')).toEqual({
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
      sessionId: PAGE_SESSION_ID,
    });
    expect(
      await client.until((message) => message.method === 'Runtime.consoleAPICalled'),
    ).toHaveProperty('sessionId', 'IFRAME-SESSION');
  });
});

describe('CdpRelay lifetime', () => {
  it('surfaces a failed attach and leaves nothing behind', async () => {
    const fake = new FakeDebugger();
    fake.attachError = 'Another debugger is already attached to this target';
    const guest = { debugger: fake, getUserAgent: () => 'UA' } as unknown as RelayGuest;
    await expect(CdpRelay.open(guest)).rejects.toThrow(/already attached/);
    expect(fake.listenerCount('message')).toBe(0);
    expect(fake.listenerCount('detach')).toBe(0);
  });

  it('refuses a page whose attachment ends while the relay is starting', async () => {
    const fake = new FakeDebugger();
    const attach = fake.attach.bind(fake);
    fake.attach = (version?: string) => {
      attach(version);
      // DevTools opening, say, before the server has finished binding.
      queueMicrotask(() => {
        fake.attached = false;
        fake.emit('detach', {}, 'Replaced by DevTools');
      });
    };
    const guest = { debugger: fake, getUserAgent: () => 'UA' } as unknown as RelayGuest;
    await expect(CdpRelay.open(guest)).rejects.toThrow(/detached/);
    expect(fake.listenerCount('detach')).toBe(0);
  });

  it('refuses a page whose debugger something else already holds', async () => {
    const fake = new FakeDebugger();
    fake.attached = true;
    const guest = { debugger: fake, getUserAgent: () => 'UA' } as unknown as RelayGuest;
    await expect(CdpRelay.open(guest)).rejects.toThrow(/already/);
    expect(fake.detachCalls).toBe(0);
  });

  it('close() detaches, drops the client and stops listening, once', async () => {
    const { relay, fake, onClose } = await open();
    const client = await connect(relay.endpoint);
    relay.close();
    relay.close();
    await closedOnce(client.socket);
    expect(fake.detachCalls).toBe(1);
    expect(fake.listenerCount('message')).toBe(0);
    expect(onClose).toHaveBeenCalledOnce();
    expect(relay.isClosed).toBe(true);
    await expect(attempt(relay.endpoint)).rejects.toThrow(/ECONNREFUSED/);
  });

  // One client, once: a relay never carries a second conversation, so nothing
  // one client set up on the page can leak into the next.
  it('closes when its client leaves', async () => {
    const { relay, fake, onClose } = await open();
    const client = await connect(relay.endpoint);
    client.socket.close();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(fake.detachCalls).toBe(1);
    await expect(attempt(relay.endpoint)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('closes when the debugger detaches on its own, without detaching it again', async () => {
    const { relay, fake, onClose } = await open();
    const client = await connect(relay.endpoint);
    fake.attached = false;
    fake.emit('detach', {}, 'target closed');
    await closedOnce(client.socket);
    expect(onClose).toHaveBeenCalledWith(expect.stringContaining('target closed'));
    expect(fake.detachCalls).toBe(0);
  });

  it('drops a client that falls behind past the byte budget, rather than buffering', async () => {
    const maxQueuedBytes = 256 * 1024;
    const { relay, fake, onClose } = await open({ maxQueuedBytes });
    const client = await connect(relay.endpoint);
    await client.call(1, 'Target.setAutoAttach', { autoAttach: true, flatten: true });
    await client.until((message) => message.method === 'Target.attachedToTarget');
    client.socket.pause();
    const payload = 'x'.repeat(16 * 1024);
    // 64 MiB of events. The kernel's loopback buffers take the first few
    // megabytes whatever the budget; past those the relay must give up long
    // before the flood ends.
    const flood = 4096;
    let closedAt: number | undefined;
    for (let i = 0; i < flood; i++) {
      fake.emitEvent('Runtime.consoleAPICalled', { args: [{ value: payload }], i });
      if (closedAt === undefined && relay.isClosed) closedAt = i;
    }
    expect(closedAt).toBeDefined();
    expect(closedAt).toBeLessThan(flood / 2);
    expect(onClose).toHaveBeenCalledWith(expect.stringContaining('fell behind'));
    expect(fake.detachCalls).toBe(1);
  });

  it('keeps a client that keeps up, however much the page sends over time', async () => {
    const { relay, fake, onClose } = await open({ maxQueuedBytes: 256 * 1024 });
    const client = await connect(relay.endpoint);
    await client.call(1, 'Target.setAutoAttach', { autoAttach: true, flatten: true });
    await client.until((message) => message.method === 'Target.attachedToTarget');
    const payload = 'x'.repeat(16 * 1024);
    for (let batch = 0; batch < 40; batch++) {
      for (let i = 0; i < 5; i++) {
        fake.emitEvent('Runtime.consoleAPICalled', { args: [{ value: payload }] });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await vi.waitFor(() =>
      expect(
        client.received.filter((message) => message.method === 'Runtime.consoleAPICalled'),
      ).toHaveLength(200),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
