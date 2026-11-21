import type { BrowserWindow, Session, WebContents, WebPreferences } from 'electron';
import { browserPartitionFor, isAllowedPageUrl } from '../../shared/browser';
import { isolated } from './isolated';
import { refusePageRequests } from './pageRequests';

/**
 * What the renderer asked for when it created a `<webview>`. Nothing in it is
 * trusted: main decides what a guest is.
 */
export interface AttachParams {
  partition?: string;
  src?: string;
}

export interface AttachContext {
  /** The workspace the attaching window holds; null or undefined for none. */
  workspaceId: string | null | undefined;
}

export type AttachDecision =
  | { allow: true; webPreferences: WebPreferences }
  | { allow: false; reason: string };

/**
 * Whether a window may attach a guest, and with which preferences.
 *
 * A guest belongs to the workspace its window holds, in that workspace's own
 * partition: another partition would hand a page someone else's cookies, and a
 * window with no workspace has no business showing pages at all. The first
 * address is checked as strictly as any later navigation, except for
 * `about:blank`, the empty page a tab starts on (the address bar never
 * produces an `about:` address itself).
 *
 * Pure: the Electron handler applies the result to the real objects.
 */
export function decideAttach(
  params: AttachParams,
  requested: WebPreferences,
  context: AttachContext,
): AttachDecision {
  if (!context.workspaceId) {
    return { allow: false, reason: 'the window holds no workspace' };
  }
  if (params.partition !== browserPartitionFor(context.workspaceId)) {
    return { allow: false, reason: "the partition is not this workspace's browser partition" };
  }
  const src = params.src;
  if (src === undefined || (src !== 'about:blank' && !isAllowedPageUrl(src))) {
    return { allow: false, reason: 'the page address is not a web address' };
  }

  // The `webpreferences` attribute can carry a `partition=` of its own, and
  // Electron lets it win over the attribute checked above: the guest would
  // land in another workspace's partition, or one with no handlers at all.
  const asked = (requested as { partition?: unknown }).partition;
  if (asked !== undefined && asked !== params.partition) {
    return { allow: false, reason: 'the web preferences name a different partition' };
  }

  // Built from nothing, not copied from what the renderer asked: every key it
  // could add (a preload, its own session, `webviewTag` to nest guests) is one
  // more thing to remember to strip. A guest never gets a script of the app's;
  // no preload means no `ipcRenderer`, which keeps a page from reaching main.
  //
  // Dropping Electron's defaults is deliberate too: `disablePopups: true` goes,
  // so a popup now reaches `setWindowOpenHandler` (where `popupPolicy` decides
  // it), and `zoomFactor` goes, so guests start at
  // 100%.
  const webPreferences: WebPreferences = {
    partition: params.partition,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  };
  return { allow: true, webPreferences };
}

/** Where a guest may go: web pages only, never `file:`, `data:`, `chrome:` and the rest. */
export function decideNavigation(url: string): boolean {
  return isAllowedPageUrl(url);
}

/**
 * Whether a navigation that has already started must be undone.
 *
 * `will-navigate` does not fire when the app's page sets `<webview>.src` or
 * calls `loadURL`: those go through main's own `loadURL`. This is the backstop
 * for them. Only the main frame matters (a sub-frame cannot replace the
 * page), and `about:blank` is the page a tab starts on and the one a reverted
 * navigation lands on, so it must not revert itself forever.
 */
export function shouldRevertNavigation(url: string, isMainFrame: boolean): boolean {
  if (!isMainFrame) return false;
  return url !== 'about:blank' && !decideNavigation(url);
}

/**
 * Where the app's own window may go: its own page, nowhere else.
 *
 * The window loads the Vite dev server in development and a bundled file in
 * production. In both a link or script that moved it elsewhere would put an
 * arbitrary page inside the one window that holds the preload bridge. A
 * reload or a hash route stays on the same page, so the origin (dev) or the
 * file (production) is what is compared, ignoring query and hash.
 */
export function decideAppNavigation(
  url: string,
  own: { devOrigin?: string; pageFileUrl?: string },
): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (own.devOrigin !== undefined) return target.origin === new URL(own.devOrigin).origin;
  if (own.pageFileUrl !== undefined) {
    const page = new URL(own.pageFileUrl);
    return target.protocol === 'file:' && target.pathname === page.pathname;
  }
  return false;
}

/**
 * Called once for every guest a window has attached, with everything a later
 * feature needs to watch it. `guestId` is read once, as the guest attaches.
 *
 * Registering here is how `BrowserService` hears about guests without
 * re-plumbing `did-attach-webview`.
 *
 * Navigation goes through main: the renderer must never set `<webview>.src`
 * after attach. It would bypass `will-navigate`; the guard below reverts a
 * disallowed address, but only as a backstop.
 *
 * A listener that tracks the guest by id reads `guest.id` here, once, and keeps
 * it: a destroyed WebContents throws on `.id`, and an event handler that throws
 * is swallowed, so a `destroyed` handler that read it would leak its entry.
 */
export type GuestAttachedListener = (
  guest: WebContents,
  hostWindow: BrowserWindow,
  workspaceId: string,
  guestId: number,
) => void;

const guestAttachedListeners = new Set<GuestAttachedListener>();

/** Subscribe to attached guests. Returns the unsubscribe function. */
export function onGuestAttached(listener: GuestAttachedListener): () => void {
  guestAttachedListeners.add(listener);
  return () => guestAttachedListeners.delete(listener);
}

/**
 * The floor every guest gets, before any feature looks at it: navigation
 * limited to web pages, no popups until `installPopupPolicy` decides which
 * are allowed (a guest it never reaches keeps this refusal), and none of the
 * person's certificates or devices (`refusePageRequests`).
 */
export function secureGuest(guest: WebContents): void {
  guardNavigation(guest);
  guest.setWindowOpenHandler(() => ({ action: 'deny' }));
  refusePageRequests(guest);
}

/**
 * Keeps a page's contents on web addresses: refuses a disallowed navigation
 * before it starts, and reverts one that started anyway. Shared by guests and
 * popup windows, which hold the same kind of untrusted page.
 */
export function guardNavigation(guest: WebContents): void {
  const refuse = (event: { preventDefault(): void }, url: string) => {
    if (!decideNavigation(url)) event.preventDefault();
  };
  guest.on('will-navigate', (event, url) => refuse(event, url));
  guest.on('will-redirect', (event, url) => refuse(event, url));
  guest.on('did-start-navigation', (details) => {
    if (!shouldRevertNavigation(details.url, details.isMainFrame)) return;
    // Stopping or loading from inside the navigation's own event re-enters
    // Chromium's navigation controller and takes the whole app down (SIGTRAP
    // on Electron 43), so both wait for the event to return.
    setImmediate(() => {
      if (guest.isDestroyed()) return;
      guest.stop();
      void guest.loadURL('about:blank').catch(() => undefined);
    });
  });
}

/**
 * Wire one window's guests: vet each attach, then secure and announce each one
 * that was allowed.
 *
 * `workspaceOf` is read at attach time, not at window creation, because a
 * window can be handed a workspace after it exists.
 */
export function installGuestPolicy(
  window: BrowserWindow,
  deps: {
    workspaceOf: () => string | null | undefined;
    /** Configures the partition's rules and returns its session. Idempotent. */
    prepare: (partition: string) => Session;
  },
): void {
  const host = window.webContents;

  host.on('will-attach-webview', (event, webPreferences, params) => {
    const workspaceId = deps.workspaceOf();
    const decision = decideAttach(params, webPreferences, { workspaceId });
    if (!decision.allow) {
      event.preventDefault();
      return;
    }
    // Applied to the real objects: Electron reads both after this event.
    const { webPreferences: allowed } = decision;
    for (const key of Object.keys(webPreferences)) {
      if (!Object.prototype.hasOwnProperty.call(allowed, key))
        delete (webPreferences as Record<string, unknown>)[key];
    }
    Object.assign(webPreferences, allowed);
    // The element's `preload` attribute reaches Electron through `params`,
    // not the preferences: taken off there too.
    delete (params as { preload?: string }).preload;
    deps.prepare(params.partition as string);
  });

  host.on('did-attach-webview', (_event, guest) => {
    // Read once, now: a destroyed WebContents throws on `.id`, and an event
    // handler that throws is swallowed, leaving state that never clears.
    const guestId = guest.id;
    // Guarded first, so even a guest refused below is never unguarded.
    secureGuest(guest);
    const workspaceId = deps.workspaceOf();
    // What was checked on the way in is checked again on the way out: the
    // guest must be in the partition of the workspace this window holds.
    if (
      !workspaceId ||
      window.isDestroyed() ||
      guest.session !== deps.prepare(browserPartitionFor(workspaceId))
    ) {
      // `close()` alone is not enough on Electron 43: it destroys only main's
      // handle, and the page keeps loading and running. A popup from it then
      // takes the whole main process down. Electron starts loading `src` just
      // before this event, so that one navigation is still in flight and
      // `stop()` cancels it before the handle goes.
      guest.stop();
      guest.close();
      return;
    }
    // Each on its own: one that throws must not leave the guest unwatched by the rest.
    for (const listener of guestAttachedListeners) {
      isolated('A listener of an attached page', () =>
        listener(guest, window, workspaceId, guestId),
      );
    }
  });
}
