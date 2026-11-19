import { describe, expect, it, vi } from 'vitest';
import {
  createRelayConnection,
  jsonBytesUpTo,
  PAGE_SESSION_ID,
  type RelayPage,
} from './cdpRelayProtocol';

type Message = Record<string, unknown>;

const TARGET = { targetId: 'GUEST-TARGET', url: 'http://localhost:4719/', title: 'Fixture' };

function setup(send: RelayPage['send'] = vi.fn(async () => ({})), maxMessageBytes?: number) {
  const written: Message[] = [];
  const fail = vi.fn();
  const page: RelayPage = {
    send,
    targetInfo: async () => TARGET,
    product: 'Chrome/150.0.0.0',
    userAgent: 'Mozilla/5.0 Consola',
  };
  const relay = createRelayConnection(
    page,
    { write: (text) => written.push(JSON.parse(text)), fail },
    maxMessageBytes,
  );
  const command = (id: number, method: string, params?: Message, sessionId?: string) =>
    relay.receive(JSON.stringify({ id, method, params, sessionId }));
  const reply = (id: number) => written.find((message) => message.id === id);
  return { relay, written, fail, send, command, reply };
}

// Each reply lands a few microtasks after its command; one macrotask lets them all land.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function announced(send?: RelayPage['send'], maxMessageBytes?: number) {
  const context = setup(send, maxMessageBytes);
  context.command(1, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  await settle();
  context.written.length = 0;
  return context;
}

describe('the browser-level commands the relay answers itself', () => {
  it('reports a Chromium browser with the page’s user agent', async () => {
    const { command, reply, send } = setup();
    command(1, 'Browser.getVersion');
    await settle();
    expect(reply(1)).toEqual({
      id: 1,
      result: expect.objectContaining({
        protocolVersion: '1.3',
        product: 'Chrome/150.0.0.0',
        userAgent: 'Mozilla/5.0 Consola',
      }),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('announces the one page under its real target id when auto-attach is turned on, once', async () => {
    const { command, written } = setup();
    command(1, 'Target.setAutoAttach', { autoAttach: true, flatten: true });
    command(2, 'Target.setAutoAttach', { autoAttach: true, flatten: true });
    await settle();
    expect(written).toContainEqual({ id: 2, result: {} });
    const first = written.findIndex((message) => message.id === 1);
    expect(written.filter((message) => message.method === 'Target.attachedToTarget')).toHaveLength(
      1,
    );
    expect(written.slice(first, first + 2)).toEqual([
      { id: 1, result: {} },
      {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: PAGE_SESSION_ID,
          targetInfo: expect.objectContaining({
            targetId: 'GUEST-TARGET',
            type: 'page',
            url: 'http://localhost:4719/',
            title: 'Fixture',
            attached: true,
            browserContextId: expect.any(String),
          }),
          waitingForDebugger: false,
        },
      },
    ]);
  });

  it('describes the browser, its one page and no extra contexts', async () => {
    const { command, reply } = setup();
    command(1, 'Target.getTargetInfo');
    command(2, 'Target.getTargets');
    command(3, 'Target.getBrowserContexts');
    command(4, 'Target.setDiscoverTargets', { discover: true });
    await settle();
    expect(reply(1)).toEqual({
      id: 1,
      result: { targetInfo: expect.objectContaining({ type: 'browser' }) },
    });
    expect(reply(2)).toEqual({
      id: 2,
      result: {
        targetInfos: [expect.objectContaining({ targetId: 'GUEST-TARGET', type: 'page' })],
      },
    });
    expect(reply(3)).toEqual({ id: 3, result: { browserContextIds: [] } });
    expect(reply(4)).toEqual({ id: 4, result: {} });
  });

  it('swallows the download behaviour, which is main’s to decide', async () => {
    const { command, reply, send } = setup();
    command(1, 'Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: '/tmp/somewhere',
      eventsEnabled: true,
    });
    await settle();
    expect(reply(1)).toEqual({ id: 1, result: {} });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses any other browser-level command with a CDP error, forwarding nothing', async () => {
    const { command, reply, send } = setup();
    const refused = [
      'Target.createTarget',
      'Target.closeTarget',
      'Target.createBrowserContext',
      'Browser.close',
      'Browser.grantPermissions',
      'Storage.getCookies',
      // A page command sent without a session is not the page's.
      'Page.navigate',
    ];
    refused.forEach((method, index) => command(index + 1, method, {}));
    await settle();
    refused.forEach((method, index) => {
      expect(reply(index + 1)).toEqual({
        id: index + 1,
        error: { code: -32000, message: expect.stringContaining(method) },
      });
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores input that is not a command', async () => {
    const { relay, written, send } = setup();
    relay.receive('not json');
    relay.receive(JSON.stringify({ method: 'Browser.getVersion' }));
    relay.receive(JSON.stringify({ id: 'x', method: 'Browser.getVersion' }));
    relay.receive(JSON.stringify([1, 2]));
    await settle();
    expect(written).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('page commands', () => {
  it('forwards a page command to the page and routes its answer back to the page session', async () => {
    const send = vi.fn(async (method: string) => ({ answered: method }));
    const { command, written } = await announced(send);
    command(5, 'Runtime.evaluate', { expression: '1+1' }, PAGE_SESSION_ID);
    await settle();
    expect(send).toHaveBeenCalledWith('Runtime.evaluate', { expression: '1+1' }, undefined);
    expect(written).toEqual([
      { id: 5, result: { answered: 'Runtime.evaluate' }, sessionId: PAGE_SESSION_ID },
    ]);
  });

  it('keeps a child target’s session id, so iframes and workers reach their own target', async () => {
    const send = vi.fn(async () => ({}));
    const { command, reply } = await announced(send);
    command(5, 'Runtime.runIfWaitingForDebugger', undefined, 'IFRAME-SESSION');
    await settle();
    expect(send).toHaveBeenCalledWith('Runtime.runIfWaitingForDebugger', {}, 'IFRAME-SESSION');
    expect(reply(5)).toEqual({ id: 5, result: {}, sessionId: 'IFRAME-SESSION' });
  });

  it('answers the page’s own wait-for-debugger itself: the page was never paused', async () => {
    const send = vi.fn(async () => ({}));
    const { command, reply } = await announced(send);
    command(5, 'Runtime.runIfWaitingForDebugger', undefined, PAGE_SESSION_ID);
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(reply(5)).toEqual({ id: 5, result: {}, sessionId: PAGE_SESSION_ID });
  });

  it('replies as each command finishes, so a slow one does not hold up the rest', async () => {
    const pending: Array<() => void> = [];
    const send = vi.fn(
      (method: string) =>
        new Promise<unknown>((resolve) => pending.push(() => resolve({ method }))),
    );
    const { command, written } = await announced(send);
    command(5, 'Page.captureScreenshot', {}, PAGE_SESSION_ID);
    command(6, 'DOM.enable', {}, PAGE_SESSION_ID);
    pending[1]();
    await settle();
    expect(written.map((message) => message.id)).toEqual([6]);
    pending[0]();
    await settle();
    expect(written.map((message) => message.id)).toEqual([6, 5]);
  });

  it('turns a page’s refusal into a CDP error on that command', async () => {
    const send = vi.fn(async () => {
      throw new Error('No node with given id found');
    });
    const { command, reply } = await announced(send);
    command(5, 'DOM.describeNode', { nodeId: 9 }, PAGE_SESSION_ID);
    await settle();
    expect(reply(5)).toEqual({
      id: 5,
      error: { code: -32000, message: 'No node with given id found' },
      sessionId: PAGE_SESSION_ID,
    });
  });

  // Playwright asks for focus emulation on every page it attaches to. Granting it
  // would make Chromium treat the page as focused for as long as the agent is
  // connected; main turns it on itself, only while the agent is acting.
  it('swallows focus emulation instead of forwarding it, on any session', async () => {
    const send = vi.fn(async () => ({}));
    const { command, reply } = await announced(send);
    command(5, 'Emulation.setFocusEmulationEnabled', { enabled: true }, PAGE_SESSION_ID);
    command(6, 'Emulation.setFocusEmulationEnabled', { enabled: true }, 'IFRAME-SESSION');
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(reply(5)).toEqual({ id: 5, result: {}, sessionId: PAGE_SESSION_ID });
    expect(reply(6)).toEqual({ id: 6, result: {}, sessionId: 'IFRAME-SESSION' });
  });
});

describe('page events', () => {
  it('holds back page events until the page has been announced', async () => {
    const { relay, written } = setup();
    relay.event('Page.loadEventFired', { timestamp: 1 }, '');
    expect(written).toEqual([]);
  });

  it('routes the page’s own events to the page session and keeps a child’s session id', async () => {
    const { relay, written } = await announced();
    relay.event('Page.loadEventFired', { timestamp: 1 }, '');
    relay.event('Runtime.consoleAPICalled', { type: 'log' }, 'IFRAME-SESSION');
    expect(written).toEqual([
      { method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: PAGE_SESSION_ID },
      { method: 'Runtime.consoleAPICalled', params: { type: 'log' }, sessionId: 'IFRAME-SESSION' },
    ]);
  });
});

describe('extra sessions on the page', () => {
  // `context.newCDPSession(page)` attaches to the browser target, then to the page from there.
  async function extraSession() {
    const context = await announced();
    const sessionIn = (id: number) => {
      const result = context.reply(id)?.result as { sessionId?: string } | undefined;
      if (!result?.sessionId) throw new Error(`Command ${id} gave no session`);
      return result.sessionId;
    };
    context.command(2, 'Target.attachToBrowserTarget');
    await settle();
    const browserSession = sessionIn(2);
    context.command(
      3,
      'Target.attachToTarget',
      { targetId: 'GUEST-TARGET', flatten: true },
      browserSession,
    );
    await settle();
    const pageSession = sessionIn(3);
    context.written.length = 0;
    return { ...context, browserSession, pageSession };
  }

  it('gives a second session on the same page its commands and events', async () => {
    const { command, relay, written, send, pageSession } = await extraSession();
    expect(pageSession).not.toBe(PAGE_SESSION_ID);
    command(4, 'Accessibility.getFullAXTree', {}, pageSession);
    await settle();
    expect(send).toHaveBeenCalledWith('Accessibility.getFullAXTree', {}, undefined);
    written.length = 0;
    relay.event('Page.loadEventFired', { timestamp: 2 }, '');
    expect(written.map((message) => message.sessionId)).toEqual([PAGE_SESSION_ID, pageSession]);
  });

  it('answers browser-level commands on a browser session as it does at the root', async () => {
    const { command, reply, browserSession } = await extraSession();
    command(4, 'Target.createTarget', { url: 'about:blank' }, browserSession);
    command(5, 'Browser.getVersion', {}, browserSession);
    await settle();
    expect(reply(4)).toHaveProperty('error');
    expect(reply(4)?.sessionId).toBe(browserSession);
    expect(reply(5)).toHaveProperty('result.product', 'Chrome/150.0.0.0');
  });

  it('refuses to attach to any target but the page', async () => {
    const { command, reply, browserSession } = await extraSession();
    command(4, 'Target.attachToTarget', { targetId: 'SOMETHING-ELSE' }, browserSession);
    await settle();
    expect(reply(4)).toHaveProperty('error');
  });

  it('stops routing to a session once it is detached', async () => {
    const { command, relay, written, browserSession, pageSession } = await extraSession();
    command(4, 'Target.detachFromTarget', { sessionId: pageSession }, browserSession);
    await settle();
    written.length = 0;
    relay.event('Page.loadEventFired', { timestamp: 3 }, '');
    expect(written.map((message) => message.sessionId)).toEqual([PAGE_SESSION_ID]);
  });
});

describe('message size', () => {
  it('fails only a reply that is too large, and still sends the next one', async () => {
    const send = vi.fn(async (method: string) =>
      method === 'DOM.getDocument' ? { data: 'x'.repeat(2000) } : { data: 'small' },
    );
    const { command, reply, fail } = await announced(send, 1000);
    command(5, 'DOM.getDocument', {}, PAGE_SESSION_ID);
    command(6, 'Page.captureScreenshot', {}, PAGE_SESSION_ID);
    await settle();
    expect(reply(5)).toEqual({
      id: 5,
      error: { code: -32000, message: expect.stringContaining('too large') },
      sessionId: PAGE_SESSION_ID,
    });
    expect(reply(6)).toEqual({ id: 6, result: { data: 'small' }, sessionId: PAGE_SESSION_ID });
    expect(fail).not.toHaveBeenCalled();
  });

  // A dropped event would leave Playwright out of step with the page.
  it('gives up on the connection for an event that is too large, and writes nothing after', async () => {
    const { relay, written, fail, command } = await announced(undefined, 1000);
    relay.event('Runtime.consoleAPICalled', { args: ['x'.repeat(2000)] }, '');
    relay.event('Page.loadEventFired', { timestamp: 1 }, '');
    command(9, 'Browser.getVersion');
    await settle();
    expect(fail).toHaveBeenCalledOnce();
    expect(written).toEqual([]);
  });

  it('writes nothing once closed', async () => {
    const { relay, written, command } = await announced();
    relay.close();
    relay.event('Page.loadEventFired', { timestamp: 1 }, '');
    command(9, 'Browser.getVersion');
    await settle();
    expect(written).toEqual([]);
  });
});

describe('jsonBytesUpTo', () => {
  const exact = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

  it('counts exactly what JSON.stringify would write, in UTF-8 bytes', () => {
    const values: unknown[] = [
      null,
      true,
      false,
      0,
      -12.5,
      1e21,
      Number.NaN,
      '',
      'plain ascii',
      'quote " backslash \\ slash /',
      'controls \n\t\r\b\f \u0001 \u001f',
      'accents é ñ, CJK 漢字, emoji 😀',
      'lone surrogates \ud800 and \udfff',
      [],
      [1, 'two', null, undefined, [3]],
      {},
      { a: 1, b: 'two', skipped: undefined, nested: { list: [true, false], text: 'é' } },
    ];
    for (const value of values) {
      expect(jsonBytesUpTo(value, Number.MAX_SAFE_INTEGER)).toBe(exact(value));
    }
  });

  it('stops counting past the limit', () => {
    const big = { list: Array.from({ length: 1000 }, () => 'x'.repeat(100)) };
    expect(jsonBytesUpTo(big, 500)).toBeGreaterThan(500);
    expect(jsonBytesUpTo(big, 500)).toBeLessThan(exact(big));
  });
});
