import { randomUUID } from 'node:crypto';
import type { BrowserWindow, WebContents } from 'electron';
import {
  isAllowedPageUrl,
  type BrowserAuthCancelledMessage,
  type BrowserAuthRequestMessage,
  type BrowserCredentials,
} from '../../shared/browser';
import { IPC_CHANNELS } from '../../shared/constants';

/** A sign-in nobody answers is let go after this long. */
export const AUTH_TIMEOUT_MS = 2 * 60_000;

/** No username or password is longer than this; a longer one is not something a person typed. */
const MAX_CREDENTIAL_LENGTH = 1024;

/**
 * Whether a page's request for a username and password is shown to the
 * person. Only a navigation the person can see happening is: a `fetch`, an
 * image or any other background request is refused outright, since a page
 * could otherwise raise a prompt whenever it liked, from a hidden tab, in a
 * loop. The navigation must also be the main frame's own pending one, to the
 * same origin (never a proxy, never another site's resource), so the prompt
 * can say plainly who is asking.
 */
export function decideLogin(request: {
  isRequestForNavigation: boolean;
  requestUrl: string;
  /** Where the main frame is navigating to right now; null when it is not navigating. */
  pendingNavigationUrl: string | null;
  isProxy: boolean;
}): boolean {
  if (!request.isRequestForNavigation || request.isProxy) return false;
  const pending = request.pendingNavigationUrl;
  if (pending === null) return false;
  if (!isAllowedPageUrl(request.requestUrl) || !isAllowedPageUrl(pending)) return false;
  try {
    return new URL(request.requestUrl).origin === new URL(pending).origin;
  } catch {
    return false;
  }
}

/**
 * The server names the area ("realm"), so it is the page's text: control and
 * bidirectional-formatting characters go (they can reorder or hide what the
 * person reads), and it is cut short.
 */
export function cleanRealm(realm: unknown): string {
  return String(realm ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '')
    .slice(0, 200);
}

interface Pending {
  guestId: number;
  host: BrowserWindow;
  origin: string;
  realm: string;
  /** The tab the guest is bound to; null until it binds. The window shows the prompt only for a tab. */
  tabId: string | null;
  callback: (username?: string, password?: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AuthPromptsDeps {
  send(
    window: BrowserWindow,
    channel: string,
    payload: BrowserAuthRequestMessage | BrowserAuthCancelledMessage,
  ): void;
  newId?(): string;
}

function credentialsOf(value: unknown): BrowserCredentials | null {
  if (!value || typeof value !== 'object') return null;
  const { username, password } = value as Record<string, unknown>;
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (username.length > MAX_CREDENTIAL_LENGTH || password.length > MAX_CREDENTIAL_LENGTH) {
    return null;
  }
  return { username, password };
}

/**
 * The sign-in requests waiting for a person. A request is held by main
 * (Electron's callback cannot leave it) and the window only gets an id to
 * answer with; credentials travel once, from the window that was asked
 * straight into the callback, and are never stored or logged here.
 *
 * Every request ends: answered, cancelled by the person, or cancelled here
 * when it times out, its guest goes away or its window closes. A cancelled
 * request tells the window so, so a dialog is never left over a page that
 * has moved on.
 */
export class AuthPrompts {
  private readonly pending = new Map<string, Pending>();
  /** `guestId|origin` of prompts the person cancelled; not asked again until the page navigates. */
  private readonly declined = new Set<string>();
  private readonly newId: () => string;

  constructor(private readonly deps: AuthPromptsDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  /** Asks `host`'s person. One prompt per guest: a newer request replaces an older one. */
  public request(options: {
    guestId: number;
    host: BrowserWindow;
    origin: string;
    realm: string;
    tabId: string | null;
    callback: (username?: string, password?: string) => void;
  }): void {
    this.cancelGuest(options.guestId);
    // A window that is gone cannot be asked.
    if (!alive(options.host)) {
      options.callback();
      return;
    }
    const id = this.newId();
    const timer = setTimeout(() => this.cancel(id), AUTH_TIMEOUT_MS);
    timer.unref?.();
    this.pending.set(id, {
      guestId: options.guestId,
      host: options.host,
      origin: options.origin,
      realm: options.realm,
      tabId: options.tabId,
      callback: options.callback,
      timer,
    });
    this.tell(id);
  }

  private tell(id: string): void {
    const entry = this.pending.get(id);
    if (!entry || !alive(entry.host)) return;
    this.deps.send(entry.host, IPC_CHANNELS.BROWSER_AUTH_REQUEST, {
      id,
      tabId: entry.tabId,
      origin: entry.origin,
      realm: entry.realm,
    });
  }

  /**
   * The guest has bound to a tab: its waiting prompt is told which one (the
   * window draws a prompt over its own tab's page and holds it until that tab
   * is the one on screen). Sent again under the same id.
   */
  public bindTab(guestId: number, tabId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.guestId !== guestId || entry.tabId === tabId) continue;
      entry.tabId = tabId;
      this.tell(id);
    }
  }

  /**
   * Hands the person's answer to the page. False when the request is gone or
   * `window` is not the one asked. Anything but well-formed credentials
   * cancels.
   */
  public answer(window: BrowserWindow, id: string, credentials: unknown): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.host !== window) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    const checked = credentialsOf(credentials);
    if (checked) {
      entry.callback(checked.username, checked.password);
    } else {
      // The person said no: asking again for the same page would only nag.
      this.declined.add(`${entry.guestId}|${entry.origin}`);
      entry.callback();
    }
    return true;
  }

  public cancelGuest(guestId: number): void {
    for (const [id, entry] of [...this.pending]) if (entry.guestId === guestId) this.cancel(id);
  }

  public cancelWindow(window: BrowserWindow): void {
    for (const [id, entry] of [...this.pending]) if (entry.host === window) this.cancel(id);
  }

  public cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }

  private cancel(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.callback();
    // A window that is closing cannot be told, and needs no telling.
    if (!alive(entry.host)) return;
    this.deps.send(entry.host, IPC_CHANNELS.BROWSER_AUTH_CANCELLED, { id });
  }

  /**
   * Follows a guest's `login` events from the moment it attaches (the first
   * page often asks before the guest is bound to a tab).
   *
   * What the main frame is navigating to is tracked here, from its start to
   * its end: a navigation that finishes without committing (stopped, a 204, a
   * download, a failure) leaves nothing pending, so a later request cannot
   * borrow its origin. A new navigation also withdraws a prompt still waiting
   * for the old one, and lets a cancelled prompt be asked again. A request
   * that is not `decideLogin`'s to show is cancelled at once.
   */
  public guard(
    guest: WebContents,
    host: BrowserWindow,
    guestId: number,
    tabIdOf: () => string | null,
  ): void {
    let pendingUrl: string | null = null;
    const start = (details: { url: string; isMainFrame: boolean; isSameDocument?: boolean }) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      pendingUrl = details.url;
      this.cancelGuest(guestId);
      for (const key of [...this.declined]) {
        if (key.startsWith(`${guestId}|`)) this.declined.delete(key);
      }
    };
    const redirect = (details: { url: string; isMainFrame: boolean }) => {
      if (details.isMainFrame) pendingUrl = details.url;
    };
    const end = () => {
      pendingUrl = null;
    };
    guest.on('did-start-navigation', start);
    guest.on('did-redirect-navigation', redirect);
    guest.on('did-navigate', end);
    guest.on('did-stop-loading', end);
    guest.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame) end();
    });
    guest.on('login', (event, details, authInfo, callback) => {
      // Cancelled unless this passes: the page never waits on a prompt that
      // was not meant to be shown.
      event.preventDefault();
      let origin: string;
      try {
        origin = new URL(details.url).origin;
      } catch {
        callback();
        return;
      }
      const allowed = decideLogin({
        isRequestForNavigation: details.isRequestForNavigation === true,
        requestUrl: details.url,
        pendingNavigationUrl: pendingUrl,
        isProxy: authInfo.isProxy,
      });
      if (!allowed || !alive(host) || this.declined.has(`${guestId}|${origin}`)) {
        callback();
        return;
      }
      this.request({
        guestId,
        host,
        origin,
        realm: cleanRealm(authInfo.realm),
        tabId: tabIdOf(),
        callback,
      });
    });
    guest.once('destroyed', () => {
      this.cancelGuest(guestId);
      for (const key of [...this.declined]) {
        if (key.startsWith(`${guestId}|`)) this.declined.delete(key);
      }
    });
  }
}

function alive(window: BrowserWindow): boolean {
  return !window.isDestroyed?.() && !window.webContents?.isDestroyed?.();
}
