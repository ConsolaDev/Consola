import type { Debugger, WebContents } from 'electron';
import type { ConnectOverCDPTransport } from 'playwright-core';
import {
  createRelayConnection,
  MAX_COMMANDS_IN_FLIGHT,
  type RelayConnection,
  type RelayPage,
} from './cdpRelayProtocol';

/** The guest page the relay serves; a `WebContents` is one. */
export type RelayGuest = Pick<
  WebContents,
  'debugger' | 'getUserAgent' | 'isDevToolsOpened' | 'on' | 'removeListener'
>;

/** What the relay answers when the person has DevTools open on the tab. */
export const DEVTOOLS_OPEN_MESSAGE =
  'DevTools is open on this tab; close it to let the agent use the page.';

export interface CdpRelayOptions {
  /** Called once, when the relay closes for any reason, `close()` included. */
  onClose?: (reason: string) => void;
  /** Tests lower it; the default is `MAX_COMMANDS_IN_FLIGHT`. */
  maxCommandsInFlight?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detachQuietly(pageDebugger: Debugger): void {
  try {
    if (pageDebugger.isAttached()) pageDebugger.detach();
  } catch (error) {
    // A page destroyed under the relay has nothing left to detach.
    console.warn('Could not detach from the page:', messageOf(error));
  }
}

/**
 * Lets `playwright-core` drive one guest page: pass the relay itself to
 * `chromium.connectOverCDP(relay)`, so the agent's browser tools get
 * Playwright's element finding and waiting on top of a page the person can
 * see (spec decision 5).
 *
 * It is Playwright's in-process transport, not a server. Nothing listens on
 * any port, so there is no address for another process or a web page to
 * find, and Consola never starts with `--remote-debugging-port`, which would
 * expose every window, its own included. The only way in is the object main
 * holds. What CDP it speaks is `cdpRelayProtocol`'s, which presents one page
 * and holds the page's own sessions to that page: Chromium would otherwise
 * answer them for every target in the app, Consola's windows included, and
 * for the disk.
 *
 * The relay holds the page's debugger attachment from `open` to `close`, and
 * a relay carries one Playwright connection: once closed it stays closed, and
 * a new connection needs a new relay, so nothing one connection set up on the
 * page carries into the next.
 *
 * The person comes first. Electron 43 lets DevTools and this attachment share
 * a `<webview>` guest (despite its docs, opening DevTools does not end the
 * attachment), so the relay steps aside itself: it will not open while
 * DevTools is open on the page, and it closes when DevTools opens. Electron's
 * own `detach` (the page closing, its renderer going away) closes it too.
 *
 * Memory: nothing is queued. Events go to Playwright as Electron delivers
 * them, and answers as the page gives them. What can grow is the set of
 * commands waiting on a page that has stopped answering, and that is capped
 * (`MAX_COMMANDS_IN_FLIGHT`); past it the relay closes.
 */
export class CdpRelay implements ConnectOverCDPTransport {
  /** Set by Playwright when it takes the transport. */
  public onmessage?: (message: object) => void;
  /** Set by Playwright; told when the relay closes, whoever closed it. */
  public onclose?: (reason?: string) => void;

  private readonly connection: RelayConnection;
  private closed = false;
  /** Chromium ended the attachment itself, so there is nothing left to detach. */
  private dropped = false;

  /**
   * Attaches to the page's debugger. Throws, leaving nothing attached, if the
   * page cannot be debugged: DevTools is open on it (`DEVTOOLS_OPEN_MESSAGE`),
   * another client already holds its debugger, or the page is gone.
   */
  public static open(guest: RelayGuest, options: CdpRelayOptions = {}): CdpRelay {
    if (guest.isDevToolsOpened()) throw new Error(DEVTOOLS_OPEN_MESSAGE);
    const pageDebugger = guest.debugger;
    if (pageDebugger.isAttached()) {
      throw new Error('Could not attach to the page: its debugger is already in use.');
    }
    try {
      pageDebugger.attach('1.3');
    } catch (error) {
      throw new Error(`Could not attach to the page: ${messageOf(error)}`);
    }
    return new CdpRelay(guest, options);
  }

  private constructor(
    private readonly guest: RelayGuest,
    private readonly options: CdpRelayOptions,
  ) {
    this.connection = createRelayConnection(
      this.page(),
      {
        // A message with nobody to take it is dropped, never held. Playwright
        // sets `onmessage` before it sends anything, and the relay writes only
        // in answer to what it sent, so this drops only what arrives after
        // Playwright has gone.
        write: (message) => this.onmessage?.(message),
        fail: (reason) => this.close(reason),
      },
      options.maxCommandsInFlight ?? MAX_COMMANDS_IN_FLIGHT,
    );
    guest.debugger.on('message', this.onDebuggerMessage);
    guest.debugger.on('detach', this.onDebuggerDetach);
    guest.on('devtools-opened', this.onDevToolsOpened);
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  /** From Playwright: one CDP command. Answered later, never inside this call. */
  public send(message: object): void {
    if (!this.closed) this.connection.receive(message);
  }

  /**
   * Detaches from the page and disconnects Playwright. Idempotent. Playwright
   * calls it when its browser closes; main calls it when the tab goes away.
   */
  public close(reason = 'The relay was closed.'): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
    const pageDebugger = this.guest.debugger;
    // The listeners come off first, so this detach never reads as Chromium's own.
    pageDebugger.removeListener('message', this.onDebuggerMessage);
    pageDebugger.removeListener('detach', this.onDebuggerDetach);
    this.guest.removeListener('devtools-opened', this.onDevToolsOpened);
    if (!this.dropped) detachQuietly(pageDebugger);
    // Main first, so it knows why before Playwright reports the disconnect;
    // each on its own, so one that throws cannot keep the other from hearing.
    for (const notify of [this.options.onClose, this.onclose]) {
      try {
        notify?.(reason);
      } catch (error) {
        console.warn('A listener for the relay closing failed:', messageOf(error));
      }
    }
  }

  /**
   * Main's own switch for focus emulation, sent through the same attachment.
   * The relay swallows Playwright's request for it, so a page the person is
   * not looking at is never told it has focus for as long as the agent stays
   * connected; main turns it on only while the agent acts.
   *
   * Seen on Electron 43, in a window that never had OS focus: turned on and
   * off with nothing in between, `document.hasFocus()` returns to false.
   * Task 19's probes then found why CDP typing only seemed to need a click
   * first: Chromium delivers a guest's CDP keys and text to whatever the
   * window has focused, and a CDP click is what made that the page. Both
   * are refused now (`cdpRelayProtocol`), and acts type inside the page; the
   * emulation is what gives them the focus events and `hasFocus()` a rich
   * editor waits for.
   */
  public async setFocusEmulation(enabled: boolean): Promise<void> {
    if (this.closed) throw new Error('The relay is closed.');
    await this.guest.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled });
  }

  private page(): RelayPage {
    const pageDebugger = this.guest.debugger;
    const chrome = process.versions.chrome;
    return {
      send: (method, params, sessionId) =>
        sessionId === undefined
          ? pageDebugger.sendCommand(method, params)
          : pageDebugger.sendCommand(method, params, sessionId),
      targetInfo: async () => {
        const answer = await pageDebugger.sendCommand('Target.getTargetInfo');
        const info = answer?.targetInfo;
        if (typeof info?.targetId !== 'string') {
          throw new Error('The page did not say which target it is.');
        }
        return {
          targetId: info.targetId,
          url: typeof info.url === 'string' ? info.url : '',
          title: typeof info.title === 'string' ? info.title : '',
        };
      },
      // Playwright reads the Chromium major version from this to pick behaviour.
      product: chrome ? `Chrome/${chrome}` : 'Chrome',
      userAgent: this.guest.getUserAgent(),
    };
  }

  private readonly onDebuggerMessage = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId: string,
  ): void => {
    this.connection.event(method, params, sessionId);
  };

  private readonly onDebuggerDetach = (_event: unknown, reason: string): void => {
    this.dropped = true;
    this.close(`The page's debugger detached (${reason}).`);
  };

  private readonly onDevToolsOpened = (): void => {
    this.close(DEVTOOLS_OPEN_MESSAGE);
  };
}
