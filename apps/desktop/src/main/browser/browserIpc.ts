import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import type { BrowserSessionSnapshot, BrowserTab } from '../../shared/browser';
import { IPC_CHANNELS } from '../../shared/constants';
import type { guardedIpc } from '../guardedIpc';
import type { BrowserService } from './BrowserService';
import { decideGuestBinding } from './guestOwnership';

export interface BrowserIpcDeps {
  ipc: Pick<typeof guardedIpc, 'handle' | 'removeHandler'>;
  service: BrowserService;
  /** The workspace the window that sent this holds, if any. */
  workspaceForSender(sender: WebContents): string | undefined;
  windowForSender(sender: WebContents): BrowserWindow | undefined;
  /** Whether the session exists and belongs to the workspace. */
  sessionInWorkspace(sessionId: string, workspaceId: string): boolean;
  webContentsFromId(id: number): WebContents | undefined;
  /** The Electron session of a workspace's browser partition. */
  sessionForWorkspace(workspaceId: string): unknown;
}

const CHANNELS = [
  IPC_CHANNELS.BROWSER_GET,
  IPC_CHANNELS.BROWSER_OPEN,
  IPC_CHANNELS.BROWSER_CLOSE,
  IPC_CHANNELS.BROWSER_ACTIVATE,
  IPC_CHANNELS.BROWSER_NAVIGATE,
  IPC_CHANNELS.BROWSER_BACK,
  IPC_CHANNELS.BROWSER_FORWARD,
  IPC_CHANNELS.BROWSER_RELOAD,
  IPC_CHANNELS.BROWSER_STOP,
  IPC_CHANNELS.BROWSER_ATTACH,
];

const EMPTY: BrowserSessionSnapshot = { tabs: [], activeTabId: null };

/**
 * The renderer's way into the in-app browser. Every handler resolves the
 * sender's workspace and refuses a session or tab that is not in it: ids come
 * from the renderer and are checked here, never trusted.
 */
export function registerBrowserHandlers(deps: BrowserIpcDeps): { remove(): void } {
  const { ipc, service } = deps;
  // A window's guests are let go when it closes. Hooked at the window's first
  // attach, since a window that never attached has nothing to let go.
  const watched = new WeakSet<BrowserWindow>();

  const ownedTab = (event: IpcMainInvokeEvent, tabId: string): boolean => {
    const workspaceId = deps.workspaceForSender(event.sender);
    return !!workspaceId && service.tabBelongsToWorkspace(tabId, workspaceId);
  };
  const ownedSession = (event: IpcMainInvokeEvent, sessionId: string): boolean => {
    const workspaceId = deps.workspaceForSender(event.sender);
    return !!workspaceId && deps.sessionInWorkspace(sessionId, workspaceId);
  };

  ipc.handle(
    IPC_CHANNELS.BROWSER_GET,
    (event, sessionId: string): BrowserSessionSnapshot =>
      ownedSession(event, sessionId) ? service.snapshotFor(sessionId) : EMPTY,
  );

  ipc.handle(
    IPC_CHANNELS.BROWSER_OPEN,
    (event, sessionId: string, url: string): BrowserTab | null =>
      ownedSession(event, sessionId)
        ? service.openTab(sessionId, String(url ?? ''), 'person')
        : null,
  );

  ipc.handle(IPC_CHANNELS.BROWSER_CLOSE, (event, tabId: string) => {
    if (ownedTab(event, tabId)) service.closeTab(tabId);
  });
  ipc.handle(IPC_CHANNELS.BROWSER_ACTIVATE, (event, tabId: string) => {
    if (ownedTab(event, tabId)) service.activateTab(tabId);
  });
  ipc.handle(IPC_CHANNELS.BROWSER_NAVIGATE, (event, tabId: string, url: string): boolean =>
    ownedTab(event, tabId) ? service.navigate(tabId, String(url ?? '')) : false,
  );
  ipc.handle(IPC_CHANNELS.BROWSER_BACK, (event, tabId: string) => {
    if (ownedTab(event, tabId)) service.goBack(tabId);
  });
  ipc.handle(IPC_CHANNELS.BROWSER_FORWARD, (event, tabId: string) => {
    if (ownedTab(event, tabId)) service.goForward(tabId);
  });
  ipc.handle(IPC_CHANNELS.BROWSER_RELOAD, (event, tabId: string) => {
    if (ownedTab(event, tabId)) service.reload(tabId);
  });
  ipc.handle(IPC_CHANNELS.BROWSER_STOP, (event, tabId: string) => {
    if (ownedTab(event, tabId)) service.stop(tabId);
  });

  ipc.handle(
    IPC_CHANNELS.BROWSER_ATTACH,
    (event, tabId: string, webContentsId: number): boolean => {
      const workspaceId = deps.workspaceForSender(event.sender);
      const window = deps.windowForSender(event.sender);
      if (!workspaceId || !window) return false;
      const guest = deps.webContentsFromId(webContentsId);
      // bindGuest reads navigation history, which throws on a destroyed guest.
      if (!guest || guest.isDestroyed()) return false;

      const decision = decideGuestBinding({
        destroyed: false,
        type: guest.getType(),
        hostIsSender: guest.hostWebContents === event.sender,
        inWorkspacePartition: guest.session === deps.sessionForWorkspace(workspaceId),
        tabInWorkspace: service.tabBelongsToWorkspace(tabId, workspaceId),
      });
      if (!decision.ok) {
        console.warn(`Refused to bind a page to tab ${tabId}: ${decision.reason}`);
        return false;
      }
      if (!watched.has(window)) {
        watched.add(window);
        window.once('closed', () => service.detachWindow(window));
      }
      return service.bindGuest(tabId, guest, window);
    },
  );

  return { remove: () => CHANNELS.forEach((channel) => ipc.removeHandler(channel)) };
}
