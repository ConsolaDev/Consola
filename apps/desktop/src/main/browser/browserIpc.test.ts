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
    bindGuest: vi.fn(() => true),
    detachWindow: vi.fn(),
  };
  deps = {
    ipc: {
      handle: (channel, listener) => handlers.set(channel, listener as Handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    service: service as unknown as BrowserService,
    workspaceForSender: () => workspace,
    windowForSender: () => window as unknown as BrowserWindow | undefined,
    sessionInWorkspace: (sessionId, ws) => sessionId === 's-mine' && ws === 'w1',
    webContentsFromId: (id) => contents.get(id) as WebContents | undefined,
    sessionForWorkspace: () => partition,
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

describe('tab-scoped handlers', () => {
  const tabCalls: Array<[string, string, unknown[]]> = [
    [IPC_CHANNELS.BROWSER_CLOSE, 'closeTab', []],
    [IPC_CHANNELS.BROWSER_ACTIVATE, 'activateTab', []],
    [IPC_CHANNELS.BROWSER_NAVIGATE, 'navigate', ['https://a.com']],
    [IPC_CHANNELS.BROWSER_BACK, 'goBack', []],
    [IPC_CHANNELS.BROWSER_FORWARD, 'goForward', []],
    [IPC_CHANNELS.BROWSER_RELOAD, 'reload', []],
    [IPC_CHANNELS.BROWSER_STOP, 'stop', []],
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
