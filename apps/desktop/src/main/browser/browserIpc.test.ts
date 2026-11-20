import type { BrowserWindow, WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/constants';
import type { BrowserService } from './BrowserService';
import { type BrowserIpcDeps, registerBrowserHandlers } from './browserIpc';

type Handler = (event: { sender: WebContents }, ...args: unknown[]) => unknown;

const sender = { id: 1 } as unknown as WebContents;
const event = { sender };
const partition = { name: 'partition of w1' };

let handlers: Map<string, Handler>;
let service: Record<string, ReturnType<typeof vi.fn>>;
let authAnswer: ReturnType<typeof vi.fn>;
let personNavigated: ReturnType<typeof vi.fn<(tabId: string) => void>>;
let workspace: string | undefined;
let window: { once: ReturnType<typeof vi.fn> } | undefined;
let contents: Map<number, Partial<WebContents>>;
let deps: BrowserIpcDeps;

const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.(event, ...args);

function guest(overrides: Partial<Record<string, unknown>> = {}): Partial<WebContents> {
  return {
    isDestroyed: () => false,
    getType: () => 'webview',
    hostWebContents: sender,
    session: partition,
    ...overrides,
  } as unknown as Partial<WebContents>;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  handlers = new Map();
  workspace = 'w1';
  window = { once: vi.fn() };
  contents = new Map();
  service = {
    // Tabs 't-mine' and sessions 's-mine' belong to w1; everything else is foreign.
    tabBelongsToWorkspace: vi.fn((tabId: string, ws: string) => tabId === 't-mine' && ws === 'w1'),
    snapshotFor: vi.fn(() => ({ tabs: [], activeTabId: 'x' })),
    openTab: vi.fn(() => ({ id: 'new' })),
    closeTab: vi.fn(),
    activateTab: vi.fn(),
    navigate: vi.fn(() => true),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    hardReload: vi.fn(),
    findText: vi.fn(),
    stopFind: vi.fn(),
    zoom: vi.fn(() => 1),
    capturePage: vi.fn(async () => ({ sessionId: 's-mine', png: Buffer.from([1]) })),
    openDevTools: vi.fn(),
    historyFor: vi.fn(() => [{ url: 'https://a.com', title: 'A', at: 1 }]),
    bindGuest: vi.fn(() => true),
    detachWindow: vi.fn(),
    setVisible: vi.fn(),
    continueCertificate: vi.fn(() => true),
    clearBrowsingData: vi.fn(async () => {}),
  };
  authAnswer = vi.fn(() => true);
  personNavigated = vi.fn<(tabId: string) => void>();
  deps = {
    ipc: {
      handle: (channel, listener) => handlers.set(channel, listener as Handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    service: { ...service, auth: { answer: authAnswer } } as unknown as BrowserService,
    workspaceForSender: () => workspace,
    windowForSender: () => window as unknown as BrowserWindow | undefined,
    sessionInWorkspace: (sessionId, ws) => sessionId === 's-mine' && ws === 'w1',
    webContentsFromId: (id) => contents.get(id) as WebContents | undefined,
    sessionForWorkspace: () => partition,
    saveCapture: async (sessionId) => `/captures/${sessionId}/x.png`,
    localServersFor: async () => [{ port: 5173, command: 'vite', url: 'http://localhost:5173' }],
    personNavigated,
  };
  registerBrowserHandlers(deps);
});

describe('session-scoped handlers', () => {
  it('serve a session of the sender workspace', () => {
    expect(call(IPC_CHANNELS.BROWSER_GET, 's-mine')).toEqual({ tabs: [], activeTabId: 'x' });
    expect(call(IPC_CHANNELS.BROWSER_OPEN, 's-mine', 'https://a.com')).toEqual({ id: 'new' });
    expect(service.openTab).toHaveBeenCalledWith('s-mine', 'https://a.com', 'person');
  });

  it('refuse a session of another workspace', () => {
    expect(call(IPC_CHANNELS.BROWSER_GET, 's-foreign')).toEqual({ tabs: [], activeTabId: null });
    expect(call(IPC_CHANNELS.BROWSER_OPEN, 's-foreign', 'https://a.com')).toBeNull();
    expect(service.snapshotFor).not.toHaveBeenCalled();
    expect(service.openTab).not.toHaveBeenCalled();
  });

  it('refuse everything for a window that holds no workspace', () => {
    workspace = undefined;
    expect(call(IPC_CHANNELS.BROWSER_GET, 's-mine')).toEqual({ tabs: [], activeTabId: null });
    expect(call(IPC_CHANNELS.BROWSER_OPEN, 's-mine', '')).toBeNull();
    expect(service.openTab).not.toHaveBeenCalled();
  });
});

describe('local servers', () => {
  const servers = [{ port: 5173, command: 'vite', url: 'http://localhost:5173' }];

  it('are listed for a session of the sender workspace', async () => {
    expect(await call(IPC_CHANNELS.BROWSER_LOCAL_SERVERS, 's-mine')).toEqual(servers);
  });

  it('are refused for a session of another workspace', async () => {
    expect(await call(IPC_CHANNELS.BROWSER_LOCAL_SERVERS, 's-foreign')).toEqual([]);
  });

  it('are refused for a window that holds no workspace', async () => {
    workspace = undefined;
    expect(await call(IPC_CHANNELS.BROWSER_LOCAL_SERVERS, 's-mine')).toEqual([]);
  });
});

describe('capture', () => {
  it('writes the capture under the tab’s session and answers its path', async () => {
    expect(await call(IPC_CHANNELS.BROWSER_CAPTURE, 't-mine')).toBe('/captures/s-mine/x.png');
  });

  it('is refused for a foreign tab and for a window with no workspace', async () => {
    expect(await call(IPC_CHANNELS.BROWSER_CAPTURE, 't-foreign')).toBeNull();
    workspace = undefined;
    expect(await call(IPC_CHANNELS.BROWSER_CAPTURE, 't-mine')).toBeNull();
    expect(service.capturePage).not.toHaveBeenCalled();
  });

  it('answers null when the tab has no page to capture', async () => {
    service.capturePage.mockResolvedValueOnce(null);
    expect(await call(IPC_CHANNELS.BROWSER_CAPTURE, 't-mine')).toBeNull();
  });
});

describe('tab-scoped handlers', () => {
  const tabCalls: Array<[string, string, unknown[]]> = [
    [IPC_CHANNELS.BROWSER_CLOSE, 'closeTab', []],
    [IPC_CHANNELS.BROWSER_ACTIVATE, 'activateTab', []],
    [IPC_CHANNELS.BROWSER_NAVIGATE, 'navigate', ['https://a.com']],
    [IPC_CHANNELS.BROWSER_BACK, 'goBack', []],
    [IPC_CHANNELS.BROWSER_FORWARD, 'goForward', []],
    [IPC_CHANNELS.BROWSER_RELOAD, 'reload', []],
    [IPC_CHANNELS.BROWSER_STOP, 'stop', []],
    [IPC_CHANNELS.BROWSER_HARD_RELOAD, 'hardReload', []],
    [IPC_CHANNELS.BROWSER_FIND, 'findText', ['text', { forward: true, next: false }]],
    [IPC_CHANNELS.BROWSER_STOP_FIND, 'stopFind', []],
    [IPC_CHANNELS.BROWSER_ZOOM, 'zoom', ['in']],
    [IPC_CHANNELS.BROWSER_DEVTOOLS, 'openDevTools', []],
    [IPC_CHANNELS.BROWSER_CERTIFICATE_CONTINUE, 'continueCertificate', []],
  ];

  it.each(tabCalls)('%s reaches the service for the workspace tab', (channel, method, extra) => {
    call(channel, 't-mine', ...extra);
    expect(service[method]).toHaveBeenCalledTimes(1);
    expect(service[method].mock.calls[0][0]).toBe('t-mine');
  });

  it.each(tabCalls)('%s is refused for a foreign tab', (channel, method, extra) => {
    call(channel, 't-foreign', ...extra);
    expect(service[method]).not.toHaveBeenCalled();
  });

  it.each(tabCalls)('%s is refused for a window with no workspace', (channel, method, extra) => {
    workspace = undefined;
    call(channel, 't-mine', ...extra);
    expect(service[method]).not.toHaveBeenCalled();
  });

  it('navigate answers false when refused', () => {
    expect(call(IPC_CHANNELS.BROWSER_NAVIGATE, 't-foreign', 'https://a.com')).toBe(false);
    expect(call(IPC_CHANNELS.BROWSER_NAVIGATE, 't-mine', 'https://a.com')).toBe(true);
  });

  const moving: readonly string[] = [
    IPC_CHANNELS.BROWSER_NAVIGATE,
    IPC_CHANNELS.BROWSER_BACK,
    IPC_CHANNELS.BROWSER_FORWARD,
    IPC_CHANNELS.BROWSER_RELOAD,
    IPC_CHANNELS.BROWSER_HARD_RELOAD,
  ];
  const toolbarMoves = tabCalls.filter(([channel]) => moving.includes(channel));

  it.each(toolbarMoves)(
    "%s is the person's input on the tab, heard before the tab moves",
    (channel, method, extra) => {
      service[method].mockImplementation(() => {
        expect(personNavigated).toHaveBeenCalledWith('t-mine');
        return true;
      });
      call(channel, 't-mine', ...extra);
      expect(personNavigated).toHaveBeenCalledTimes(1);
      expect(service[method]).toHaveBeenCalledTimes(1);
    },
  );

  it.each(toolbarMoves)('%s on a foreign tab is nobody’s input', (channel, _method, extra) => {
    call(channel, 't-foreign', ...extra);
    expect(personNavigated).not.toHaveBeenCalled();
  });

  it('nothing but a move from the toolbar counts as the person navigating', () => {
    for (const [channel, , extra] of tabCalls) {
      if (moving.includes(channel)) continue;
      call(channel, 't-mine', ...extra);
    }
    expect(personNavigated).not.toHaveBeenCalled();
  });
});

describe('sign-in answers and clearing data', () => {
  const auth = () => authAnswer;

  it('hands an answer to the service on behalf of the sender window only', () => {
    call(IPC_CHANNELS.BROWSER_AUTH_ANSWER, 'req1', { username: 'u', password: 'p' });
    expect(auth()).toHaveBeenCalledWith(window, 'req1', { username: 'u', password: 'p' });
  });

  it('ignores an answer with no window or a request id that is not text', () => {
    call(IPC_CHANNELS.BROWSER_AUTH_ANSWER, 5, null);
    expect(auth()).not.toHaveBeenCalled();
    window = undefined;
    call(IPC_CHANNELS.BROWSER_AUTH_ANSWER, 'req1', null);
    expect(auth()).not.toHaveBeenCalled();
  });

  it('clears the sender workspace only, whatever the caller passes', async () => {
    await call(IPC_CHANNELS.BROWSER_CLEAR_DATA, 'w-other');
    expect(service.clearBrowsingData).toHaveBeenCalledWith('w1');
  });

  it('clears nothing for a window that holds no workspace', async () => {
    workspace = undefined;
    await call(IPC_CHANNELS.BROWSER_CLEAR_DATA);
    expect(service.clearBrowsingData).not.toHaveBeenCalled();
  });
});

describe('zoom and history', () => {
  it('zoom answers the level for an owned tab and the default for a foreign one', () => {
    expect(call(IPC_CHANNELS.BROWSER_ZOOM, 't-mine', 'get')).toBe(1);
    expect(call(IPC_CHANNELS.BROWSER_ZOOM, 't-foreign', 'get')).toBe(0);
  });

  it('history is the sender workspace only, whatever the caller passes', () => {
    expect(call(IPC_CHANNELS.BROWSER_HISTORY, 'w-other')).toHaveLength(1);
    expect(service.historyFor).toHaveBeenCalledWith('w1');
    workspace = undefined;
    service.historyFor.mockClear();
    expect(call(IPC_CHANNELS.BROWSER_HISTORY)).toEqual([]);
    expect(service.historyFor).not.toHaveBeenCalled();
  });
});

describe('set visible', () => {
  it('reports the tab of the sender workspace for this window', () => {
    call(IPC_CHANNELS.BROWSER_SET_VISIBLE, 's-mine', 't-mine');
    expect(service.setVisible).toHaveBeenCalledWith(window, 's-mine', 't-mine');
  });

  it('takes none as nothing shown', () => {
    call(IPC_CHANNELS.BROWSER_SET_VISIBLE, null, null);
    expect(service.setVisible).toHaveBeenCalledWith(window, null, null);
  });

  it.each([
    ['a foreign session', 's-foreign', 't-mine'],
    ['a foreign tab', 's-mine', 't-foreign'],
    ['junk', 5, {}],
  ])('takes %s as nothing shown', (_label, sessionId, tabId) => {
    call(IPC_CHANNELS.BROWSER_SET_VISIBLE, sessionId, tabId);
    expect(service.setVisible).toHaveBeenCalledWith(window, null, null);
  });

  it('shows nothing for a window with no workspace, and is ignored without a window', () => {
    workspace = undefined;
    call(IPC_CHANNELS.BROWSER_SET_VISIBLE, 's-mine', 't-mine');
    expect(service.setVisible).toHaveBeenCalledWith(window, null, null);
    window = undefined;
    service.setVisible.mockClear();
    call(IPC_CHANNELS.BROWSER_SET_VISIBLE, 's-mine', 't-mine');
    expect(service.setVisible).not.toHaveBeenCalled();
  });
});

describe('attach', () => {
  it('binds a webview of this window, in this partition, to the workspace tab', () => {
    contents.set(7, guest());
    expect(call(IPC_CHANNELS.BROWSER_ATTACH, 't-mine', 7)).toBe(true);
    expect(service.bindGuest).toHaveBeenCalledWith('t-mine', contents.get(7), window);
  });

  it('hooks the window close once, however many guests attach', () => {
    contents.set(7, guest());
    call(IPC_CHANNELS.BROWSER_ATTACH, 't-mine', 7);
    call(IPC_CHANNELS.BROWSER_ATTACH, 't-mine', 7);
    expect(window?.once).toHaveBeenCalledTimes(1);
    expect(window?.once.mock.calls[0][0]).toBe('closed');
  });

  it.each<[string, () => void, number]>([
    ['no workspace', () => (workspace = undefined), 7],
    ['no window', () => (window = undefined), 7],
    ['an id that is no contents', () => {}, 99],
    ['a destroyed contents', () => contents.set(7, guest({ isDestroyed: () => true })), 7],
    [
      'a contents that is not a webview',
      () => contents.set(7, guest({ getType: () => 'window' })),
      7,
    ],
    ["another window's webview", () => contents.set(7, guest({ hostWebContents: {} })), 7],
    ['another partition', () => contents.set(7, guest({ session: {} })), 7],
  ])('refuses %s', (_label, arrange, id) => {
    contents.set(7, guest());
    arrange();
    expect(call(IPC_CHANNELS.BROWSER_ATTACH, 't-mine', id)).toBe(false);
    expect(service.bindGuest).not.toHaveBeenCalled();
  });

  it('refuses a foreign tab', () => {
    contents.set(7, guest());
    expect(call(IPC_CHANNELS.BROWSER_ATTACH, 't-foreign', 7)).toBe(false);
    expect(service.bindGuest).not.toHaveBeenCalled();
  });

  it('remove() unregisters every channel', () => {
    const { remove } = registerBrowserHandlers(deps);
    remove();
    expect(handlers.size).toBe(0);
  });
});
