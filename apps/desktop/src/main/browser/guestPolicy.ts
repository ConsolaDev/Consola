import type { BrowserWindow, WebContents, WebPreferences } from 'electron';
import { browserPartitionFor, isAllowedPageUrl } from '../../shared/browser';

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

  // A copy, so the caller's object is only ever changed by the caller.
  const webPreferences: WebPreferences & Record<string, unknown> = { ...requested };
  // A guest never gets a script of the app's: no preload means no
  // `ipcRenderer`, which is what keeps a page from reaching main.
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  delete webPreferences.additionalArguments;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  return { allow: true, webPreferences };
}

/** Where a guest may go: web pages only, never `file:`, `data:`, `chrome:` and the rest. */
export function decideNavigation(url: string): boolean {
  return isAllowedPageUrl(url);
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
 * feature needs to watch it. Registering here is how `BrowserService` hears
 * about guests without re-plumbing `did-attach-webview`.
 *
 * A listener that tracks the guest by id reads `guest.id` here, once, and keeps
 * it: a destroyed WebContents throws on `.id`, and an event handler that throws
 * is swallowed, so a `destroyed` handler that read it would leak its entry.
 */
export type GuestAttachedListener = (
  guest: WebContents,
  hostWindow: BrowserWindow,
  workspaceId: string,
) => void;

const guestAttachedListeners = new Set<GuestAttachedListener>();

/** Subscribe to attached guests. Returns the unsubscribe function. */
export function onGuestAttached(listener: GuestAttachedListener): () => void {
  guestAttachedListeners.add(listener);
  return () => guestAttachedListeners.delete(listener);
}

/**
 * The floor every guest gets, before any feature looks at it: navigation
 * limited to web pages, and no popups until a later feature decides which are
 * allowed.
 */
export function secureGuest(guest: WebContents): void {
  const refuse = (event: { preventDefault(): void }, url: string) => {
    if (!decideNavigation(url)) event.preventDefault();
  };
  guest.on('will-navigate', (event, url) => refuse(event, url));
  guest.on('will-redirect', (event, url) => refuse(event, url));
  guest.setWindowOpenHandler(() => ({ action: 'deny' }));
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
    prepare: (partition: string) => void;
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
      if (!(key in allowed)) delete (webPreferences as Record<string, unknown>)[key];
    }
    Object.assign(webPreferences, allowed);
    // Also set on params: the attribute is read from there too.
    delete (params as { preload?: string }).preload;
    deps.prepare(params.partition as string);
  });

  host.on('did-attach-webview', (_event, guest) => {
    secureGuest(guest);
    const workspaceId = deps.workspaceOf();
    if (!workspaceId || window.isDestroyed()) return;
    for (const listener of guestAttachedListeners) listener(guest, window, workspaceId);
  });
}
