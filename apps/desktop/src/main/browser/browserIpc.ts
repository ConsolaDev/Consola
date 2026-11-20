import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import type {
  BrowserHistoryEntry,
  BrowserSessionSnapshot,
  BrowserTab,
  LocalServer,
} from '../../shared/browser';
import type { ZoomStep } from '../../shared/browserTools';
import { isLoopbackHost } from '../../shared/browser';
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
  /** The servers started from the session's checkout; null when the scan could not answer. */
  localServersFor(sessionId: string): Promise<LocalServer[] | null>;
  /** Where a capture is written; answers the file's path. */
  saveCapture(sessionId: string, png: Buffer): Promise<string>;
  webContentsFromId(id: number): WebContents | undefined;
  /** The Electron session of a workspace's browser partition. */
  sessionForWorkspace(workspaceId: string): unknown;
  /**
   * The person moved a tab from Consola's toolbar: their input on it, as a
   * press in its page is (`PersonInput.notePersonNavigation`). Only these
   * handlers call it; an agent's moves never come through here.
   */
  personNavigated(tabId: string): void;
}

/** A web address on this machine, which is all the window retries by itself. */
function isLoopbackAddress(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      isLoopbackHost(parsed.hostname)
    );
  } catch {
    return false;
  }
}

const CHANNELS = [
  IPC_CHANNELS.BROWSER_GET,
  IPC_CHANNELS.BROWSER_OPEN,
  IPC_CHANNELS.BROWSER_CLOSE,
  IPC_CHANNELS.BROWSER_ACTIVATE,
  IPC_CHANNELS.BROWSER_NAVIGATE,
  IPC_CHANNELS.BROWSER_RETRY,
  IPC_CHANNELS.BROWSER_BACK,
  IPC_CHANNELS.BROWSER_FORWARD,
  IPC_CHANNELS.BROWSER_RELOAD,
  IPC_CHANNELS.BROWSER_STOP,
  IPC_CHANNELS.BROWSER_ATTACH,
  IPC_CHANNELS.BROWSER_SET_VISIBLE,
  IPC_CHANNELS.BROWSER_HARD_RELOAD,
  IPC_CHANNELS.BROWSER_FIND,
  IPC_CHANNELS.BROWSER_STOP_FIND,
  IPC_CHANNELS.BROWSER_ZOOM,
  IPC_CHANNELS.BROWSER_DEVTOOLS,
  IPC_CHANNELS.BROWSER_HISTORY,
  IPC_CHANNELS.BROWSER_CERTIFICATE_CONTINUE,
  IPC_CHANNELS.BROWSER_AUTH_ANSWER,
  IPC_CHANNELS.BROWSER_CLEAR_DATA,
  IPC_CHANNELS.BROWSER_LOCAL_SERVERS,
  IPC_CHANNELS.BROWSER_CAPTURE,
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
  /** One of the window's own tabs, which the person is moving: heard as theirs first. */
  const movedByPerson = (event: IpcMainInvokeEvent, tabId: string): boolean => {
    if (!ownedTab(event, tabId)) return false;
    deps.personNavigated(tabId);
    return true;
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
  // The person's own moves of a tab: input of theirs on it, so the tab is in
  // their hands for its downloads (`decideDownload`), and an agent's act gives
  // way to them for `PERSON_INPUT_GUARD_MS`.
  ipc.handle(IPC_CHANNELS.BROWSER_NAVIGATE, (event, tabId: string, url: string): boolean =>
    movedByPerson(event, tabId) ? service.navigate(tabId, String(url ?? '')) : false,
  );
  ipc.handle(IPC_CHANNELS.BROWSER_BACK, (event, tabId: string) => {
    if (movedByPerson(event, tabId)) service.goBack(tabId);
  });
  // The window's automatic retry of an unreachable page on this machine: a
  // timer, not the person, so it records nothing, whatever it is sent, and it
  // goes only to a loopback address (what the window retries by itself).
  ipc.handle(IPC_CHANNELS.BROWSER_RETRY, (event, tabId: string, url: unknown): boolean => {
    if (!ownedTab(event, tabId) || typeof url !== 'string' || !isLoopbackAddress(url)) return false;
    return service.navigate(tabId, url);
  });
  ipc.handle(IPC_CHANNELS.BROWSER_FORWARD, (event, tabId: string) => {
    if (movedByPerson(event, tabId)) service.goForward(tabId);
  });
  ipc.handle(IPC_CHANNELS.BROWSER_RELOAD, (event, tabId: string) => {
    if (movedByPerson(event, tabId)) service.reload(tabId);
  });
  ipc.handle(IPC_CHANNELS.BROWSER_STOP, (event, tabId: string) => {
    if (ownedTab(event, tabId)) service.stop(tabId);
  });

  ipc.handle(IPC_CHANNELS.BROWSER_HARD_RELOAD, (event, tabId: string) => {
    if (movedByPerson(event, tabId)) service.hardReload(tabId);
  });
  ipc.handle(
    IPC_CHANNELS.BROWSER_FIND,
    (event, tabId: string, text: string, options: { forward: boolean; next: boolean }) => {
      if (ownedTab(event, tabId)) service.findText(tabId, text, options);
    },
  );
  ipc.handle(IPC_CHANNELS.BROWSER_STOP_FIND, (event, tabId: string) => {
    if (ownedTab(event, tabId)) service.stopFind(tabId);
  });
  ipc.handle(IPC_CHANNELS.BROWSER_ZOOM, (event, tabId: string, step: ZoomStep | 'get'): number =>
    ownedTab(event, tabId) ? service.zoom(tabId, step) : 0,
  );
  ipc.handle(IPC_CHANNELS.BROWSER_DEVTOOLS, (event, tabId: string) => {
    if (ownedTab(event, tabId)) service.openDevTools(tabId);
  });
  // No argument: the workspace is the sender's own, so a window can never ask
  // for another workspace's history by naming it.
  ipc.handle(IPC_CHANNELS.BROWSER_HISTORY, (event): BrowserHistoryEntry[] => {
    const workspaceId = deps.workspaceForSender(event.sender);
    return workspaceId ? service.historyFor(workspaceId) : [];
  });

  // Names a session, so it is checked like every session-scoped call: another
  // workspace's folders are not for this window to learn about.
  ipc.handle(
    IPC_CHANNELS.BROWSER_LOCAL_SERVERS,
    async (event, sessionId: string): Promise<LocalServer[] | null> =>
      ownedSession(event, sessionId) ? await deps.localServersFor(sessionId) : [],
  );

  // Checked like every tab-scoped call. The image never leaves main: only the
  // path of the file it was written to goes back.
  ipc.handle(IPC_CHANNELS.BROWSER_CAPTURE, async (event, tabId: string): Promise<string | null> => {
    if (!ownedTab(event, tabId)) return null;
    const captured = await service.capturePage(tabId);
    return captured ? await deps.saveCapture(captured.sessionId, captured.png) : null;
  });

  // The person chose to go on past a refused certificate: their input on the tab.
  ipc.handle(IPC_CHANNELS.BROWSER_CERTIFICATE_CONTINUE, (event, tabId: string): boolean =>
    movedByPerson(event, tabId) ? service.continueCertificate(tabId) : false,
  );
  // The request id alone is not authority: main only accepts it from the
  // window that was asked, so another window cannot answer, or cancel, for it.
  // An answer, or a cancel, is the person's input on the tab that asked.
  ipc.handle(IPC_CHANNELS.BROWSER_AUTH_ANSWER, (event, id: string, credentials: unknown) => {
    const window = deps.windowForSender(event.sender);
    if (!window || typeof id !== 'string') return;
    const tabId = service.auth.requestTab(window, id);
    if (tabId) deps.personNavigated(tabId);
    service.auth.answer(window, id, credentials);
  });
  // No argument, like history: a window clears its own workspace and no other.
  ipc.handle(IPC_CHANNELS.BROWSER_CLEAR_DATA, async (event) => {
    const workspaceId = deps.workspaceForSender(event.sender);
    if (workspaceId) await service.clearBrowsingData(workspaceId);
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

  ipc.handle(
    IPC_CHANNELS.BROWSER_SET_VISIBLE,
    (event, sessionId: string | null, tabId: string | null) => {
      const window = deps.windowForSender(event.sender);
      if (!window) return;
      // A session or tab that is not this window's workspace's is taken as
      // "nothing shown": the window is not showing a page it cannot own.
      const mine =
        typeof sessionId === 'string' &&
        typeof tabId === 'string' &&
        ownedSession(event, sessionId) &&
        ownedTab(event, tabId);
      service.setVisible(window, mine ? sessionId : null, mine ? tabId : null);
    },
  );

  return { remove: () => CHANNELS.forEach((channel) => ipc.removeHandler(channel)) };
}
