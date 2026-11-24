import { describe, expect, it, vi } from 'vitest';
import { createRelayConnection, PAGE_SESSION_ID } from './cdpRelayProtocol';
import type { RelayPage } from './cdpRelayProtocol';
import { EventBudget, TOO_MANY_BYTES_MESSAGE, TOO_MANY_EVENTS_MESSAGE } from './relayBudget';

type Message = Record<string, unknown>;

const TARGET = { targetId: 'GUEST-TARGET', url: 'http://localhost:4719/', title: 'Fixture' };

function setup(
  send: RelayPage['send'] = vi.fn(async () => ({})),
  maxCommandsInFlight?: number,
  budget?: EventBudget,
) {
  const written: Message[] = [];
  const fail = vi.fn();
  const warn = vi.fn();
  const page: RelayPage = {
    send,
    targetInfo: async () => TARGET,
    product: 'Chrome/150.0.0.0',
    userAgent: 'Mozilla/5.0 Consola',
  };
  const relay = createRelayConnection(
    page,
    { write: (message) => written.push(message), fail },
    { maxCommandsInFlight, budget, warn },
  );
  // Shaped as Playwright's CRConnection sends them: sessionId only when there is one.
  const command = (id: number, method: string, params?: Message, sessionId?: string) =>
    relay.receive(
      sessionId === undefined ? { id, method, params } : { id, method, params, sessionId },
    );
  const reply = (id: number) => written.find((message) => message.id === id);
  return { relay, written, fail, warn, send, command, reply };
}

// Each reply lands a few microtasks after its command; one macrotask lets them all land.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The session id Chromium gave the page's one cross-site iframe. */
const CHILD = 'IFRAME-SESSION';

/** What the debugger emits when Chromium auto-attaches one of the page's iframes or workers. */
const attachedEvent = (sessionId: string) => ({
  sessionId,
  targetInfo: { targetId: `${sessionId}-TARGET`, type: 'iframe', url: 'http://other/' },
  waitingForDebugger: true,
});

/** A connection whose page has been announced, with one iframe Chromium attached under it. */
async function announced(
  send?: RelayPage['send'],
  maxCommandsInFlight?: number,
  budget?: EventBudget,
) {
  const context = setup(send, maxCommandsInFlight, budget);
  context.command(1, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  await settle();
  context.relay.event('Target.attachedToTarget', attachedEvent(CHILD), '');
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
    relay.receive('{"id":1,"method":"Browser.getVersion"}');
    relay.receive(null);
    relay.receive({ method: 'Browser.getVersion' });
    relay.receive({ id: 'x', method: 'Browser.getVersion' });
    relay.receive({ id: 1, method: 'Browser.getVersion', params: 'nope' });
    relay.receive([1, 2]);
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
    // With its user gesture taken off: an agent's script opens no chooser.
    expect(send).toHaveBeenCalledWith(
      'Runtime.evaluate',
      { expression: '1+1', userGesture: false },
      undefined,
    );
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
    command(6, 'Page.getFrameTree', {}, PAGE_SESSION_ID);
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

// Chromium answers the page's own debugger session for far more than the page:
// it lists every target in the app, Consola's own window included, attaches to
// any of them, and sets where downloads go. So the page's sessions get only
// what drives the page itself.
describe('what the page’s own sessions may not do', () => {
  const sessions = [PAGE_SESSION_ID, CHILD];

  async function refusedOnBoth(method: string, params: Message = {}) {
    const send = vi.fn(async () => ({}));
    const { command, reply } = await announced(send);
    command(50, method, params, PAGE_SESSION_ID);
    command(51, method, params, CHILD);
    await settle();
    for (const [id, sessionId] of [
      [50, PAGE_SESSION_ID],
      [51, CHILD],
    ] as const) {
      expect(reply(id)).toEqual({
        id,
        error: { code: -32000, message: expect.stringContaining(method) },
        sessionId,
      });
    }
    expect(send).not.toHaveBeenCalled();
  }

  // What Playwright 1.62.1 sends on the browser tools' paths, recorded across the
  // agent end-to-end specs: these, and nothing else, reach the page.
  it.each([
    ['DOM.describeNode', { objectId: 'o1' }],
    ['DOM.resolveNode', { backendNodeId: 3 }],
    ['DOM.getContentQuads', { objectId: 'o1' }],
    ['DOM.scrollIntoViewIfNeeded', { objectId: 'o1' }],
    ['Log.enable', {}],
    ['Network.enable', {}],
    ['Page.enable', {}],
    ['Page.getFrameTree', {}],
    ['Page.setLifecycleEventsEnabled', { enabled: true }],
    ['Page.addScriptToEvaluateOnNewDocument', { source: '1', worldName: 'w' }],
    ['Page.createIsolatedWorld', { frameId: 'F', worldName: 'w' }],
    ['Page.getLayoutMetrics', {}],
    ['Page.captureScreenshot', { format: 'png' }],
    ['Runtime.enable', {}],
    ['Runtime.evaluate', { expression: '1' }],
    ['Runtime.callFunctionOn', { functionDeclaration: 'f' }],
    ['Runtime.releaseObject', { objectId: 'o1' }],
    ['Target.setAutoAttach', { autoAttach: true, flatten: true }],
  ])('passes %s on to the page and to its iframes', async (method, params) => {
    const send = vi.fn(async () => ({}));
    const { command, reply } = await announced(send);
    command(50, method, params, PAGE_SESSION_ID);
    command(51, method, params, CHILD);
    await settle();
    expect(reply(50)).toHaveProperty('result');
    expect(reply(51)).toHaveProperty('result');
    expect(send).toHaveBeenCalledTimes(2);
  });

  // Unknown is refused: the list is what the tools use, never what Playwright might ask.
  it.each([
    ['Accessibility.getFullAXTree', {}],
    ['CacheStorage.requestCacheNames', { securityOrigin: 'https://bank.example' }],
    ['IndexedDB.requestDatabaseNames', { securityOrigin: 'https://bank.example' }],
    ['DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: 'https://bank.example' } }],
    ['FileSystem.getDirectory', {}],
    ['ServiceWorker.unregister', { scopeURL: 'https://bank.example/' }],
    ['Network.clearBrowserCache', {}],
    ['Network.loadNetworkResource', { url: 'file:///etc/hosts' }],
    ['Network.setExtraHTTPHeaders', { headers: {} }],
    ['Fetch.enable', { handleAuthRequests: true }],
    ['Security.setIgnoreCertificateErrors', { ignore: true }],
    ['Page.setInterceptFileChooserDialog', { enabled: true }],
    ['Page.setWebLifecycleState', { state: 'frozen' }],
    ['Page.reload', {}],
    ['Overlay.setInspectMode', { mode: 'searchForNode' }],
    ['Debugger.enable', {}],
    ['Emulation.setDeviceMetricsOverride', { width: 1, height: 1 }],
    ['Emulation.setScriptExecutionDisabled', { value: true }],
    ['HeapProfiler.takeHeapSnapshot', {}],
    ['Memory.getDOMCounters', {}],
    ['IO.read', { handle: '1' }],
    ['Runtime.terminateExecution', {}],
    ['NoSuch.method', {}],
  ])('refuses %s, which the browser tools never send, and logs it', async (method, params) => {
    const send = vi.fn(async () => ({}));
    const { command, reply, warn } = await announced(send);
    command(50, method, params, PAGE_SESSION_ID);
    command(51, method, params, CHILD);
    await settle();
    for (const id of [50, 51]) {
      expect(reply(id)).toMatchObject({
        error: { message: expect.stringContaining(method) },
      });
    }
    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(method));
  });

  it('answers media emulation itself: the person’s page is never restyled for the agent', async () => {
    const send = vi.fn(async () => ({}));
    const { command, reply } = await announced(send);
    command(50, 'Emulation.setEmulatedMedia', { media: '', features: [] }, PAGE_SESSION_ID);
    command(51, 'Emulation.setEmulatedMedia', { media: 'print' }, CHILD);
    await settle();
    expect(reply(50)).toHaveProperty('result');
    expect(reply(51)).toHaveProperty('result');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['Target.getTargets', {}],
    ['Target.attachToTarget', { targetId: 'HOST-WINDOW', flatten: true }],
    ['Target.attachToBrowserTarget', {}],
    ['Target.setDiscoverTargets', { discover: true }],
    ['Target.createTarget', { url: 'about:blank' }],
    ['Target.closeTarget', { targetId: 'HOST-WINDOW' }],
    ['Target.activateTarget', { targetId: 'HOST-WINDOW' }],
    ['Target.exposeDevToolsProtocol', { targetId: 'GUEST-TARGET' }],
    ['Target.sendMessageToTarget', { message: '{}', sessionId: 'X' }],
  ])('refuses %s, which reaches other targets', async (method, params) => {
    await refusedOnBoth(method, params);
  });

  it.each([
    ['Browser.getVersion'],
    ['Browser.setDockTile'],
    ['Browser.getWindowForTarget'],
    ['Browser.grantPermissions'],
    ['Storage.getCookies'],
    ['SystemInfo.getProcessInfo'],
    ['Tracing.start'],
  ])('refuses %s, which is browser-wide', async (method) => {
    await refusedOnBoth(method);
  });

  it.each([
    ['Network.getAllCookies'],
    ['Network.getCookies'],
    ['Network.setCookie'],
    ['Network.setCookies'],
    ['Network.deleteCookies'],
    ['Network.clearBrowserCookies'],
  ])('refuses %s: the partition’s cookies are not the page’s to hand out', async (method) => {
    await refusedOnBoth(method);
  });

  it('refuses to set where downloads go, and answers Browser.setDownloadBehavior itself', async () => {
    await refusedOnBoth('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' });
    const send = vi.fn(async () => ({}));
    const { command, reply } = await announced(send);
    command(5, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' }, CHILD);
    command(6, 'Browser.setDownloadBehavior', { behavior: 'allow' }, PAGE_SESSION_ID);
    await settle();
    expect(reply(5)).toEqual({ id: 5, result: {}, sessionId: CHILD });
    expect(reply(6)).toEqual({ id: 6, result: {}, sessionId: PAGE_SESSION_ID });
    expect(send).not.toHaveBeenCalled();
  });

  // No files reach a page from an agent.
  it('never hands a local file to the page', async () => {
    await refusedOnBoth('DOM.setFileInputFiles', { files: ['/etc/hosts'], nodeId: 3 });
    await refusedOnBoth('Input.dispatchDragEvent', {
      type: 'drop',
      x: 1,
      y: 1,
      data: { items: [], files: ['/etc/hosts'], dragOperationsMask: 1 },
    });
    const send = vi.fn(async () => ({}));
    const { command, reply } = await announced(send);
    command(
      5,
      'Input.dispatchDragEvent',
      {
        type: 'drop',
        x: 1,
        y: 1,
        data: { items: [], files: ['/etc/hosts'], dragOperationsMask: 1 },
      },
      PAGE_SESSION_ID,
    );
    await settle();
    expect(reply(5)).toMatchObject({
      error: { message: expect.stringContaining('cannot hand files') },
    });
  });

  // Agent input must never take the person's keyboard: Chromium hands a
  // guest's CDP keys and text to whatever the window has focused (the
  // person's terminal, when it has the keyboard), and a trusted press makes
  // the page the window's focused element. Only moving the mouse and the
  // wheel are input-free.
  it.each([
    ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', text: 'a' }],
    ['Input.insertText', { text: 'rm -rf ~' }],
    ['Input.imeSetComposition', { text: 'a', selectionStart: 0, selectionEnd: 1 }],
  ])('refuses %s, which would type wherever the window’s keyboard is', async (method, params) => {
    await refusedOnBoth(method, params);
    const { command, reply } = await announced();
    command(5, method, params, PAGE_SESSION_ID);
    await settle();
    expect(reply(5)).toMatchObject({ error: { message: expect.stringContaining('terminal') } });
  });

  it.each([
    [
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 },
    ],
    [
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 },
    ],
    ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, button: 'left', buttons: 1 }],
    ['Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 1, y: 1 }] }],
    [
      'Input.dispatchDragEvent',
      { type: 'dragEnter', x: 1, y: 1, data: { items: [], dragOperationsMask: 1 } },
    ],
    ['Input.synthesizeTapGesture', { x: 1, y: 1 }],
    ['Input.emulateTouchFromMouseEvent', { type: 'mousePressed', x: 1, y: 1, button: 'left' }],
    ['Input.setIgnoreInputEvents', { ignore: true }],
    ['Input.setInterceptDrags', { enabled: true }],
  ])('refuses %s %j, which presses on the page or reaches past it', async (method, params) => {
    await refusedOnBoth(method, params);
  });

  // An agent's script never carries a user gesture, so nothing it
  // runs can open a file or colour chooser, go fullscreen, or anything else a
  // page allows only on a real press.
  it.each([['Runtime.evaluate'], ['Runtime.callFunctionOn']])(
    'sends %s with no user gesture, whatever was asked, on the page and in a frame',
    async (method) => {
      const send = vi.fn(async () => ({}));
      const { command, reply } = await announced(send);
      command(
        5,
        method,
        { expression: 'x', functionDeclaration: 'f', userGesture: true },
        PAGE_SESSION_ID,
      );
      command(6, method, { expression: 'x', functionDeclaration: 'f' }, CHILD);
      await settle();
      expect(reply(5)).toHaveProperty('result');
      expect(reply(6)).toHaveProperty('result');
      expect(send.mock.calls).toEqual([
        [method, { expression: 'x', functionDeclaration: 'f', userGesture: false }, undefined],
        [method, { expression: 'x', functionDeclaration: 'f', userGesture: false }, CHILD],
      ]);
    },
  );

  it('leaves every other command’s parameters as they were', async () => {
    const send = vi.fn(async () => ({}));
    const { command } = await announced(send);
    command(5, 'DOM.describeNode', { objectId: 'o1', depth: 1 }, PAGE_SESSION_ID);
    await settle();
    expect(send).toHaveBeenCalledWith('DOM.describeNode', { objectId: 'o1', depth: 1 }, undefined);
  });

  it('refuses a mouse move that names a button, held or not', async () => {
    await refusedOnBoth('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 1,
      y: 1,
      button: 'left',
      buttons: 0,
    });
  });

  it('lets the mouse move and the wheel turn, with no button held', async () => {
    const send = vi.fn(async () => ({}));
    const { command, reply } = await announced(send);
    command(
      5,
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: 5, y: 6, button: 'none', buttons: 0 },
      PAGE_SESSION_ID,
    );
    command(
      6,
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: 5, y: 6, deltaX: 0, deltaY: 100 },
      CHILD,
    );
    await settle();
    expect(reply(5)).toHaveProperty('result');
    expect(reply(6)).toHaveProperty('result');
    expect(send).toHaveBeenCalledTimes(2);
  });

  // These three act on every process of the app, not on the page.
  it.each([
    ['Memory.simulatePressureNotification', { level: 'critical' }],
    ['Memory.setPressureNotificationsSuppressed', { suppressed: true }],
    ['Memory.getBrowserSamplingProfile', {}],
  ])('refuses %s, which reaches the whole app', async (method, params) => {
    await refusedOnBoth(method, params);
  });

  // Bringing the page to the front would take the window's focus, and closing
  // a tab is Consola's, never the agent's through the page.
  it.each([['Page.bringToFront'], ['Page.close'], ['Page.crash']])(
    'refuses %s on the person’s page',
    async (method) => {
      await refusedOnBoth(method);
    },
  );

  // The same rule as an address the person types; main's
  // did-start-navigation check stays as the other wall.
  it.each([
    ['file:///etc/hosts'],
    ['data:text/html,<p>hi</p>'],
    ['javascript:alert(1)'],
    ['chrome://settings'],
    ['about:blank'],
    ['not a url'],
  ])('refuses to navigate to %s', async (url) => {
    await refusedOnBoth('Page.navigate', { url, frameId: 'F' });
  });

  it('navigates to a web page, on the page and in an iframe', async () => {
    const send = vi.fn(async () => ({ frameId: 'F' }));
    const { command, reply } = await announced(send);
    command(5, 'Page.navigate', { url: 'https://example.com/' }, PAGE_SESSION_ID);
    command(6, 'Page.navigate', { url: 'http://localhost:3000/', frameId: 'F' }, CHILD);
    await settle();
    expect(reply(5)).toHaveProperty('result');
    expect(reply(6)).toHaveProperty('result');
    expect(send).toHaveBeenCalledWith('Page.navigate', { url: 'https://example.com/' }, undefined);
    expect(send).toHaveBeenCalledWith(
      'Page.navigate',
      { url: 'http://localhost:3000/', frameId: 'F' },
      CHILD,
    );
  });

  it('goes back or forward only to a history entry that is a web page', async () => {
    const history = {
      currentIndex: 1,
      entries: [
        { id: 1, url: 'https://example.com/' },
        { id: 2, url: 'https://example.com/next' },
        { id: 3, url: 'file:///etc/hosts' },
      ],
    };
    const send = vi.fn(async (method: string) =>
      method === 'Page.getNavigationHistory' ? history : {},
    );
    const { command, reply } = await announced(send);
    command(5, 'Page.navigateToHistoryEntry', { entryId: 1 }, PAGE_SESSION_ID);
    command(6, 'Page.navigateToHistoryEntry', { entryId: 3 }, PAGE_SESSION_ID);
    command(7, 'Page.navigateToHistoryEntry', { entryId: 99 }, PAGE_SESSION_ID);
    await settle();
    expect(reply(5)).toEqual({ id: 5, result: {}, sessionId: PAGE_SESSION_ID });
    expect(reply(6)).toHaveProperty('error');
    expect(reply(7)).toHaveProperty('error');
    expect(send.mock.calls.filter(([method]) => method === 'Page.navigateToHistoryEntry')).toEqual([
      ['Page.navigateToHistoryEntry', { entryId: 1 }, undefined],
    ]);
  });

  it('lets through the Target commands that drive the page’s own iframes and workers', async () => {
    const send = vi.fn(async () => ({}));
    const { command, reply } = await announced(send);
    const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
    command(5, 'Target.setAutoAttach', autoAttach, CHILD);
    command(6, 'Target.getTargetInfo', {}, PAGE_SESSION_ID);
    command(7, 'Target.getTargetInfo', { targetId: 'GUEST-TARGET' }, PAGE_SESSION_ID);
    command(8, 'Target.getTargetInfo', { targetId: 'HOST-WINDOW' }, PAGE_SESSION_ID);
    command(9, 'Target.detachFromTarget', { sessionId: CHILD }, PAGE_SESSION_ID);
    command(10, 'Target.detachFromTarget', { sessionId: 'HOST-SESSION' }, PAGE_SESSION_ID);
    await settle();
    for (const id of [5, 6, 7, 9]) expect(reply(id)).toHaveProperty('result');
    for (const id of [8, 10]) expect(reply(id)).toHaveProperty('error');
    expect(send.mock.calls).toHaveLength(4);
    expect(send.mock.calls).toEqual(
      expect.arrayContaining([
        ['Target.setAutoAttach', autoAttach, CHILD],
        ['Target.getTargetInfo', {}, undefined],
        ['Target.getTargetInfo', { targetId: 'GUEST-TARGET' }, undefined],
        ['Target.detachFromTarget', { sessionId: CHILD }, undefined],
      ]),
    );
  });

  it.each(sessions)('still forwards ordinary page commands on %s', async (sessionId) => {
    const send = vi.fn(async () => ({}));
    const { command, reply } = await announced(send);
    command(5, 'Page.getFrameTree', {}, sessionId);
    await settle();
    expect(reply(5)).toHaveProperty('result');
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('the page’s iframes and workers', () => {
  it('forwards to one only after Chromium has announced it, and not after it detached', async () => {
    const send = vi.fn(async () => ({}));
    const { command, reply, relay } = await announced(send);
    command(5, 'Runtime.enable', {}, 'NESTED');
    // An iframe inside the iframe, announced on the iframe's own session.
    relay.event('Target.attachedToTarget', attachedEvent('NESTED'), CHILD);
    command(6, 'Runtime.enable', {}, 'NESTED');
    relay.event('Target.detachedFromTarget', { sessionId: 'NESTED' }, CHILD);
    command(7, 'Runtime.enable', {}, 'NESTED');
    await settle();
    expect(reply(5)).toEqual({
      id: 5,
      error: { code: -32000, message: 'No such session.' },
      sessionId: 'NESTED',
    });
    expect(reply(6)).toEqual({ id: 6, result: {}, sessionId: 'NESTED' });
    expect(reply(7)).toHaveProperty('error');
    expect(send).toHaveBeenCalledOnce();
  });

  it('refuses a session id Chromium never announced for this page', async () => {
    const send = vi.fn(async () => ({}));
    const { command, reply, relay } = await announced(send);
    // An announcement heard on a session that is not the page's grants nothing.
    relay.event('Target.attachedToTarget', attachedEvent('HOST-SESSION'), 'STRANGER');
    command(5, 'Runtime.evaluate', { expression: 'window.HOST_SECRET' }, 'HOST-SESSION');
    await settle();
    expect(reply(5)).toHaveProperty('error');
    expect(send).not.toHaveBeenCalled();
  });

  it('passes on events only from sessions it knows', async () => {
    const { relay, written } = await announced();
    relay.event('Runtime.executionContextCreated', { context: { id: 1 } }, 'STRANGER');
    relay.event('Runtime.executionContextCreated', { context: { id: 2 } }, CHILD);
    expect(written).toEqual([
      {
        method: 'Runtime.executionContextCreated',
        params: { context: { id: 2 } },
        sessionId: CHILD,
      },
    ]);
  });

  it('forgets the iframes announced under one that went, which Chromium never reports', async () => {
    const send = vi.fn(async () => ({}));
    const { command, reply, relay } = await announced(send);
    relay.event('Target.attachedToTarget', attachedEvent('NESTED'), CHILD);
    relay.event('Target.attachedToTarget', attachedEvent('DEEPER'), 'NESTED');
    relay.event('Target.attachedToTarget', attachedEvent('SIBLING'), '');
    // Only the iframe's own end is reported, on the page's session.
    relay.event('Target.detachedFromTarget', { sessionId: CHILD }, '');
    command(5, 'Runtime.enable', {}, 'NESTED');
    command(6, 'Runtime.enable', {}, 'DEEPER');
    command(7, 'Runtime.enable', {}, 'SIBLING');
    await settle();
    expect(reply(5)).toHaveProperty('error');
    expect(reply(6)).toHaveProperty('error');
    expect(reply(7)).toEqual({ id: 7, result: {}, sessionId: 'SIBLING' });
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
    relay.event('Page.frameNavigated', { frame: { id: 'f' } }, 'IFRAME-SESSION');
    expect(written).toEqual([
      { method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: PAGE_SESSION_ID },
      {
        method: 'Page.frameNavigated',
        params: { frame: { id: 'f' } },
        sessionId: 'IFRAME-SESSION',
      },
    ]);
  });

  // Playwright keeps a page's last 200 console messages and errors with their
  // values, and Consola reads none of them from it.
  it.each([
    ['Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'x' }] }],
    ['Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught' } }],
    ['Log.entryAdded', { entry: { level: 'error', source: 'network', text: 'x' } }],
  ])('keeps %s from Playwright, in the page and in its iframes', async (method, params) => {
    const { relay, written } = await announced();
    relay.event(method, params, '');
    relay.event(method, params, CHILD);
    relay.event('Page.loadEventFired', { timestamp: 1 }, '');
    expect(written).toEqual([
      { method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: PAGE_SESSION_ID },
    ]);
  });
});

describe('what a page may send the connection', () => {
  it('closes it, saying why, once the page sends more events than it may', async () => {
    const { relay, fail, written } = await announced(
      undefined,
      undefined,
      new EventBudget(() => 0),
    );
    for (let i = 0; i < 25_000 && fail.mock.calls.length === 0; i++) {
      relay.event('Network.dataReceived', { requestId: '1', dataLength: 1 }, '');
    }
    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(TOO_MANY_EVENTS_MESSAGE);
    written.length = 0;
    relay.event('Page.loadEventFired', { timestamp: 1 }, '');
    expect(written).toEqual([]);
  });

  it('counts what it keeps from Playwright too, by its size', async () => {
    const { relay, fail } = await announced(undefined, undefined, new EventBudget(() => 0));
    const logged = {
      type: 'error',
      args: [{ type: 'string', value: 'x'.repeat(30 * 1024 * 1024) }],
    };
    relay.event('Runtime.consoleAPICalled', logged, '');
    relay.event('Runtime.consoleAPICalled', logged, '');
    expect(fail).not.toHaveBeenCalled();
    relay.event('Runtime.consoleAPICalled', logged, '');
    expect(fail).toHaveBeenCalledWith(TOO_MANY_BYTES_MESSAGE);
  });
});

describe('the page’s alerts and confirms', () => {
  // Main holds them for the agent (PageDialogs). Playwright, told of one and
  // given no listener, would dismiss it at once.
  it.each([['alert'], ['confirm'], ['prompt']])(
    'keeps the page’s %s, and its closing, from Playwright',
    async (type) => {
      const { relay, written } = await announced();
      relay.event('Page.javascriptDialogOpening', { type, message: 'm', url: 'u' }, '');
      relay.event('Page.javascriptDialogClosed', { result: true, userInput: '' }, '');
      relay.event('Page.loadEventFired', { timestamp: 1 }, '');
      expect(written).toEqual([
        { method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: PAGE_SESSION_ID },
      ]);
    },
  );

  it('keeps them from Playwright in an iframe too', async () => {
    const { relay, written } = await announced();
    relay.event('Page.javascriptDialogOpening', { type: 'alert', message: 'm' }, CHILD);
    relay.event('Page.javascriptDialogClosed', { result: true }, CHILD);
    expect(written).toEqual([]);
  });

  it('passes a beforeunload on, which Playwright accepts', async () => {
    const { relay, written } = await announced();
    relay.event('Page.javascriptDialogOpening', { type: 'beforeunload', message: '' }, '');
    relay.event('Page.javascriptDialogClosed', { result: true }, '');
    expect(written.map((message) => message.method)).toEqual([
      'Page.javascriptDialogOpening',
      'Page.javascriptDialogClosed',
    ]);
  });

  // A held dialog Chromium cancels (the page navigated) may send no
  // javascriptDialogClosed; the next opening on the session says what it is.
  it('reads each opening afresh, so a cancelled hold leaves nothing behind', async () => {
    const send = vi.fn(async () => ({}));
    const { relay, command, reply } = await announced(send);
    relay.event('Page.javascriptDialogOpening', { type: 'confirm', message: 'm' }, '');
    // No javascriptDialogClosed: the page went on to another document.
    relay.event('Page.javascriptDialogOpening', { type: 'beforeunload', message: '' }, '');
    command(5, 'Page.handleJavaScriptDialog', { accept: true }, PAGE_SESSION_ID);
    await settle();
    expect(reply(5)).toHaveProperty('result');
    expect(send).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: true }, undefined);
  });

  it('refuses to answer a dialog main holds, and answers a beforeunload', async () => {
    const send = vi.fn(async () => ({}));
    const { relay, command, reply } = await announced(send);
    relay.event('Page.javascriptDialogOpening', { type: 'confirm', message: 'm' }, '');
    command(5, 'Page.handleJavaScriptDialog', { accept: true }, PAGE_SESSION_ID);
    await settle();
    expect(reply(5)).toHaveProperty('error');
    relay.event('Page.javascriptDialogClosed', { result: false }, '');
    relay.event('Page.javascriptDialogOpening', { type: 'beforeunload', message: '' }, '');
    command(6, 'Page.handleJavaScriptDialog', { accept: true }, PAGE_SESSION_ID);
    await settle();
    expect(reply(6)).toHaveProperty('result');
    expect(send).toHaveBeenCalledTimes(1);
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
    command(4, 'Page.getFrameTree', {}, pageSession);
    await settle();
    expect(send).toHaveBeenCalledWith('Page.getFrameTree', {}, undefined);
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

describe('the connection itself', () => {
  // Playwright registers a command's callback only after `send` returns, so an
  // answer written inside it would never be matched and the command would hang.
  it('never answers inside receive, not even for commands it answers itself', async () => {
    const { command, written } = await announced();
    command(5, 'Browser.getVersion');
    command(6, 'Emulation.setFocusEmulationEnabled', { enabled: true }, PAGE_SESSION_ID);
    command(7, 'Target.createTarget', { url: 'about:blank' });
    expect(written).toEqual([]);
    await settle();
    expect(written.map((message) => message.id)).toEqual([5, 6, 7]);
  });

  it('ends the connection when too many commands wait on a page that stopped answering', async () => {
    const send = vi.fn(() => new Promise<unknown>(() => {}));
    const { command, fail, written } = await announced(send, 3);
    for (let id = 10; id < 13; id++) command(id, 'Runtime.releaseObject', {}, PAGE_SESSION_ID);
    expect(fail).not.toHaveBeenCalled();
    command(13, 'Runtime.releaseObject', {}, PAGE_SESSION_ID);
    expect(fail).toHaveBeenCalledWith(expect.stringContaining('stopped answering'));
    expect(send).toHaveBeenCalledTimes(3);
    command(14, 'Browser.getVersion');
    await settle();
    expect(written).toEqual([]);
  });

  it('counts a command as waiting only until it is answered', async () => {
    const { command, fail } = await announced(undefined, 3);
    for (let id = 10; id < 40; id++) {
      command(id, 'Runtime.releaseObject', {}, PAGE_SESSION_ID);
      await settle();
    }
    expect(fail).not.toHaveBeenCalled();
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
