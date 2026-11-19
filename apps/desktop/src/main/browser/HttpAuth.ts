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
 * person: only when it is the page's own origin asking (never a proxy, never
 * another site's resource embedded in it), so the dialog can say plainly who
 * is asking and a page cannot make Consola ask on behalf of another origin.
 */
export function decideLogin(request: {
  requestUrl: string;
  pageUrl: string;
  isProxy: boolean;
}): boolean {
  if (request.isProxy) return false;
  if (!isAllowedPageUrl(request.requestUrl) || !isAllowedPageUrl(request.pageUrl)) return false;
  try {
    return new URL(request.requestUrl).origin === new URL(request.pageUrl).origin;
  } catch {
    return false;
  }
}

interface Pending {
  guestId: number;
  host: BrowserWindow;
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
    callback: (username?: string, password?: string) => void;
  }): void {
    this.cancelGuest(options.guestId);
    const id = this.newId();
    const timer = setTimeout(() => this.cancel(id), AUTH_TIMEOUT_MS);
    timer.unref?.();
    this.pending.set(id, {
      guestId: options.guestId,
      host: options.host,
      callback: options.callback,
      timer,
    });
    this.deps.send(options.host, IPC_CHANNELS.BROWSER_AUTH_REQUEST, {
      id,
      origin: options.origin,
      realm: options.realm,
    });
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
    if (checked) entry.callback(checked.username, checked.password);
    else entry.callback();
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
    const { host } = entry;
    if (host.isDestroyed?.() || host.webContents?.isDestroyed?.()) return;
    this.deps.send(host, IPC_CHANNELS.BROWSER_AUTH_CANCELLED, { id });
  }

  /**
   * Follows a guest's `login` events from the moment it attaches (the first
   * page often asks before the guest is bound to a tab). The page's address
   * is where its main frame last navigated to, which is also the answer while
   * a first load is still waiting on the sign-in: the guest has committed
   * nothing yet, so `getURL()` alone would call every such request foreign. A
   * request that is not `decideLogin`'s to show is left unanswered, which
   * Electron treats as a cancel.
   */
  public guard(guest: WebContents, host: BrowserWindow, guestId: number): void {
    let mainFrameUrl = '';
    const follow = (details: { url: string; isMainFrame: boolean; isSameDocument?: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) mainFrameUrl = details.url;
    };
    guest.on('did-start-navigation', follow);
    guest.on('did-redirect-navigation', follow);
    guest.on('login', (event, details, authInfo, callback) => {
      let origin: string;
      try {
        origin = new URL(details.url).origin;
      } catch {
        return;
      }
      const allowed = decideLogin({
        requestUrl: details.url,
        pageUrl: mainFrameUrl || guest.getURL(),
        isProxy: authInfo.isProxy,
      });
      if (!allowed) return;
      // Without this Electron cancels at once; with it the page waits for the person.
      event.preventDefault();
      this.request({
        guestId,
        host,
        origin,
        realm: String(authInfo.realm ?? '').slice(0, 200),
        callback,
      });
    });
    guest.once('destroyed', () => this.cancelGuest(guestId));
  }
}
