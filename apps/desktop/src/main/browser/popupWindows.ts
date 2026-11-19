import type { BrowserWindow, WebContents } from 'electron';
import { guardNavigation } from './guestPolicy';
import { decidePopup, PersonInputClock } from './popupPolicy';

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

  // Set by the handler for the one window it allowed, taken by
  // `did-create-window`. Anything created without it is not ours to keep.
  let allowed: PopupOwner | null = null;

  guest.setWindowOpenHandler((details) => {
    const sessionId = deps.sessionIdOf(deps.guestId);
    const decision = decidePopup(details, {
      openerKnown: sessionId !== undefined,
      openerIsPopup: false,
      recentPersonInput: input.isRecent(),
      atTabCap: sessionId !== undefined && deps.atTabCap(sessionId),
    });
    if (decision.action === 'deny' || sessionId === undefined) return { action: 'deny' };
    if (decision.action === 'tab') {
      deps.openTab(sessionId, decision.url);
      return { action: 'deny' };
    }
    allowed = {
      sessionId,
      workspaceId: deps.workspaceId,
      host: deps.host,
    };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: decision.width,
        height: decision.height,
        parent: deps.host,
        show: !deps.hidden,
        focusable: !deps.hidden,
        autoHideMenuBar: true,
        webPreferences: { ...POPUP_WEB_PREFERENCES },
      },
    };
  });

  guest.on('did-create-window', (popup) => {
    const owner = allowed;
    allowed = null;
    if (!owner) {
      popup.destroy();
      return;
    }
    hardenPopup(popup);
    deps.popups.track(popup, owner);
    popup.once('closed', () => deps.popups.forget(popup));
  });
}

/** Everything a popup's page is held to, on top of the preferences it was created with. */
function hardenPopup(popup: BrowserWindow): void {
  popup.setMenu(null);
  const contents = popup.webContents;
  guardNavigation(contents);
  // Nothing opens from a popup. The page keeps `window.opener`, but it gets
  // no windows of its own.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
}
