import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from 'electron';
import type { CertificateTrust } from './CertificateTrust';
import { guardNavigation } from './guestPolicy';
import { decideGuestShortcut, type GuestKeyInput } from './guestShortcuts';
import { refusePageRequests } from './pageRequests';
import { decidePopup, PersonInputClock, popupTitle } from './popupPolicy';

/** What the registry needs of a window; a `BrowserWindow` is one. */
export interface PopupHandle {
  isDestroyed(): boolean;
  destroy(): void;
}

/** Whose a popup is, so it can be closed with them, and judged by its opener. */
export interface PopupOwner {
  sessionId: string;
  workspaceId: string | undefined;
  /** The Consola window the opener's page lives in. */
  host: unknown;
  /** The popup's own page (its `webContents.id`). */
  contentsId: number;
  /** The tab whose page opened it: what its downloads are decided by (`downloadSource`). */
  openerTabId: string | null;
}

/**
 * Every popup window that is open, and whose it is. A popup is a real window
 * outside the app's own, so nothing but this list stands between a session
 * ending and a page of it staying on screen.
 *
 * Closing is `destroy()`, not `close()`: a popup whose owner is gone must go
 * at once, without waiting on its page to unload.
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

  /** The tab whose page opened the popup showing this page, while it is open. */
  public openerTabOf(contentsId: number): string | undefined {
    for (const owner of this.open.values()) {
      if (owner.contentsId === contentsId) return owner.openerTabId ?? undefined;
    }
    return undefined;
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
  /** The tab the guest is bound to, or null while unbound. */
  tabIdOf(guestId: number): string | null;
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
  /**
   * Holds ⌘Q back in the popup by the host window's own guard, so the popup
   * is no way around it (macOS; elsewhere there is no guard to share).
   */
  guardQuit?(contents: WebContents): void;
}

/**
 * Whether a key the person pressed in a page counts as their gesture there,
 * for the popup gate's clock: a key going down that the page gets. A chord
 * the app takes from the page (`decideGuestShortcut`: the palette, closing a
 * tab, ...) and ⌘Q (held back by the quit guard) never reach the page, so
 * they cannot be what a page's `window.open` follows: a page polling for a
 * popup would otherwise get one the moment the person pressed an app
 * shortcut in it.
 */
export function isGestureKey(input: GuestKeyInput, platform: string = process.platform): boolean {
  if (input.type !== 'keyDown' || decideGuestShortcut(input, platform)) return false;
  const quitChord =
    platform === 'darwin' &&
    input.meta &&
    !input.control &&
    !input.alt &&
    !input.shift &&
    input.key.toLowerCase() === 'q';
  return !quitChord;
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
  // browser process, not from script. Only a button or a key going down
  // counts, as the person-input guard does: a release after a long press
  // would open the gate long after the guard began, and a page could follow
  // an agent's act with a popup.
  guest.on('input-event', (_event, inputEvent) => {
    if (inputEvent.type === 'mouseDown') input.touch();
  });
  guest.on('before-input-event', (_event, keyInput) => {
    if (isGestureKey(keyInput)) input.touch();
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
    const openerTabId = deps.tabIdOf(deps.guestId);
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
        deps.guardQuit?.(popup.webContents);
        closeOnCloseShortcut(popup);
        const owner: PopupOwner = {
          sessionId,
          workspaceId: deps.workspaceId,
          host: deps.host,
          contentsId: popup.webContents.id,
          openerTabId,
        };
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
 * ⌘W closes the popup: with the keyboard in it, it is the nearest thing, and
 * the window's own close moved to ⇧⌘W (which the menu still does here). The
 * chord is taken from the page, as in a tab's page. Held, it closes the popup
 * once; the repeats land wherever the keyboard goes next, which drops them.
 */
function closeOnCloseShortcut(popup: BrowserWindow): void {
  popup.webContents.on('before-input-event', (event, input) => {
    const decision = decideGuestShortcut(input);
    if (decision?.action.kind !== 'close') return;
    event.preventDefault();
    // As the window's own close button would; the page's `beforeunload`
    // cannot keep it open (`refusePageRequests`).
    if (decision.send && !popup.isDestroyed()) popup.close();
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
 * a tab. The person's client certificates and Bluetooth devices: none, as in
 * a tab (`refusePageRequests`).
 */
export function hardenPopup(
  popup: BrowserWindow,
  certificates: CertificateTrust,
  workspaceId: string | undefined,
): void {
  popup.setMenu(null);
  const contents = popup.webContents;
  if (workspaceId) certificates.guard(contents, workspaceId, contents.id);
  guardNavigation(contents);
  refusePageRequests(contents);
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
