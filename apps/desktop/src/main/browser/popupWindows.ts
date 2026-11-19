import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from 'electron';
import type { CertificateTrust } from './CertificateTrust';
import { guardNavigation } from './guestPolicy';
import { decidePopup, PersonInputClock, popupTitle } from './popupPolicy';

/** What the registry needs of a window; a `BrowserWindow` is one. */
export interface PopupHandle {
  isDestroyed(): boolean;
  destroy(): void;
}

/** Whose a popup is, so it can be closed with them. */
export interface PopupOwner {
  sessionId: string;
  workspaceId: string | undefined;
  /** The Consola window the opener's page lives in. */
  host: unknown;
}

/**
 * Every popup window that is open, and whose it is. A popup is a real window
 * outside the app's own, so nothing but this list stands between a session
 * ending and a page of it staying on screen.
 *
 * Closing is `destroy()`, not `close()`: a page's `beforeunload` can veto a
 * close, and a popup whose owner is gone must go regardless.
 */
export class PopupRegistry {
  private readonly open = new Map<PopupHandle, PopupOwner>();

  public track(popup: PopupHandle, owner: PopupOwner): void {
    this.open.set(popup, owner);
  }

  public forget(popup: PopupHandle): void {
    this.open.delete(popup);
  }

  public get size(): number {
    return this.open.size;
  }

  public closeWhere(match: (owner: PopupOwner) => boolean): void {
    for (const [popup, owner] of [...this.open]) {
      if (!match(owner)) continue;
      this.open.delete(popup);
      if (!popup.isDestroyed()) popup.destroy();
    }
  }

  public closeAll(): void {
    this.closeWhere(() => true);
  }
}

/**
 * What a page may do from inside a popup: nothing beyond showing itself.
 * Same flags as a guest, and no preload, so it has no way to reach main.
 */
const POPUP_WEB_PREFERENCES = {
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
} as const;

/** `BrowserWindow` options, plus the prepared contents Electron hands a window-open handler. */
export type PopupWindowOptions = BrowserWindowConstructorOptions & { webContents?: WebContents };

export interface PopupPolicyDeps {
  /** The window the guest lives in. */
  host: BrowserWindow;
  guestId: number;
  /** The session the guest's tab belongs to, or undefined while unbound. */
  sessionIdOf(guestId: number): string | undefined;
  workspaceId: string | undefined;
  atTabCap(sessionId: string): boolean;
  openTab(sessionId: string, url: string): void;
  popups: PopupRegistry;
  /** Answers a popup's certificate errors the way its opener's are. */
  certificates: CertificateTrust;
  /** Builds the window. Electron's `BrowserWindow` constructor, handed in so this module stays free of it. */
  createWindow(options: PopupWindowOptions): BrowserWindow;
  /** The largest a popup may be: the screen the person is using. */
  maxSize(): { width: number; height: number };
  /** An E2E run keeps windows off the desktop. */
  hidden?: boolean;
}

/**
 * Decides every window a guest's page opens (`decidePopup`) and applies it:
 * a tab goes through `BrowserService`, a popup becomes one hardened child
 * window that main tracks, and anything else is refused.
 *
 * The popup shares the guest's partition (it inherits the opener's session),
 * which is what lets a sign-in flow finish with the cookies the opener sees,
 * and keeps its `window.opener` so the page can hear back from it.
 *
 * The window is built here, from options this module owns. Electron's own
 * path would merge the page's `window.open` features over them, and a page
 * could then ask for a frameless, transparent, always-on-top, uncloseable,
 * screen-sized or modal window; `createWindow` below takes only the size.
 */
export function installPopupPolicy(guest: WebContents, deps: PopupPolicyDeps): void {
  const input = new PersonInputClock();
  // `input-event` covers the mouse, `before-input-event` the keys; either is
  // a person at the page. A page cannot forge them: they come from the
  // browser process, not from script.
  guest.on('input-event', (_event, inputEvent) => {
    if (inputEvent.type === 'mouseDown' || inputEvent.type === 'mouseUp') input.touch();
  });
  guest.on('before-input-event', (_event, keyInput) => {
    if (keyInput.type === 'keyDown') input.touch();
  });

  // The popup this page has open, if any: one at a time.
  let openPopup: BrowserWindow | null = null;
  const hasPopup = () => openPopup !== null && !openPopup.isDestroyed();

  guest.setWindowOpenHandler((details) => {
    const sessionId = deps.sessionIdOf(deps.guestId);
    const decision = decidePopup(details, {
      openerKnown: sessionId !== undefined,
      openerIsPopup: false,
      recentPersonInput: input.isRecent(),
      atTabCap: sessionId !== undefined && deps.atTabCap(sessionId),
      openerHasPopup: hasPopup(),
    });
    if (decision.action === 'deny' || sessionId === undefined) return { action: 'deny' };
    if (decision.action === 'tab') {
      deps.openTab(sessionId, decision.url);
      return { action: 'deny' };
    }
    // One gesture pays for one popup.
    input.consume();
    const owner: PopupOwner = { sessionId, workspaceId: deps.workspaceId, host: deps.host };
    const max = deps.maxSize();
    const width = Math.min(decision.width, max.width);
    const height = Math.min(decision.height, max.height);
    const webPreferences = { ...POPUP_WEB_PREFERENCES };
    return {
      action: 'allow',
      // Also given as overrides, so the contents Electron prepares for the
      // window is created with the hardened preferences, not the page's.
      overrideBrowserWindowOptions: { webPreferences },
      createWindow: (handed) => {
        const popup = deps.createWindow({
          // The contents Electron made for this window, which keeps
          // `window.opener`. Nothing else the page's features produced is used.
          // (Real, but absent from Electron's typings.)
          webContents: (handed as PopupWindowOptions).webContents,
          width,
          height,
          parent: deps.host,
          show: !deps.hidden,
          focusable: !deps.hidden,
          autoHideMenuBar: true,
          webPreferences,
        });
        openPopup = popup;
        hardenPopup(popup, deps.certificates, deps.workspaceId);
        deps.popups.track(popup, owner);
        popup.once('closed', () => {
          deps.popups.forget(popup);
          if (openPopup === popup) openPopup = null;
        });
        return popup.webContents;
      },
    };
  });
}

/**
 * Everything a popup's page is held to, on top of the preferences it was
 * created with.
 *
 * Certificates: a popup is refused a bad certificate like any page, and honours
 * only what the person already approved for the workspace. It has no "Continue
 * anyway" of its own. Sign-in: a popup has no `login` handler, so Electron
 * cancels its requests. A dialog drawn over the opener's window would ask for a
 * password while the page that wants it is in a different window, and a popup
 * is the shape a phishing page takes; a sign-in that needs one can be done in
 * a tab.
 */
function hardenPopup(
  popup: BrowserWindow,
  certificates: CertificateTrust,
  workspaceId: string | undefined,
): void {
  popup.setMenu(null);
  const contents = popup.webContents;
  if (workspaceId) certificates.guard(contents, workspaceId, contents.id);
  guardNavigation(contents);
  // Nothing opens from a popup. The page keeps `window.opener`, but it gets
  // no windows of its own.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());

  // The page picks its own title, so the window's always starts with the
  // origin it is really showing.
  const retitle = (pageTitle: string) => {
    if (!popup.isDestroyed()) popup.setTitle(popupTitle(contents.getURL(), pageTitle));
  };
  contents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    retitle(title);
  });
  contents.on('did-navigate', () => retitle(contents.getTitle()));
  retitle('');
}
