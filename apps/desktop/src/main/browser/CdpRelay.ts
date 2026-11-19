import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Debugger } from 'electron';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import {
  createRelayConnection,
  MAX_MESSAGE_BYTES,
  type RelayConnection,
  type RelayPage,
} from './cdpRelayProtocol';

/**
 * How far the client may fall behind before the relay gives up on it. A page
 * can log faster than Playwright reads, and every byte not yet read waits in
 * main's memory; relaying without a ceiling is what took T3 Code's main
 * process down (#20395). Generous enough for a burst of console output on
 * top of a large screenshot, so only a client that has stopped keeping up
 * reaches it. One message more than this can be queued at worst.
 */
export const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

/** Playwright's commands are small; the largest carry a script to inject. */
const MAX_INBOUND_BYTES = 64 * 1024 * 1024;

/** The parts of `webContents.debugger` the relay uses. */
export type RelayDebugger = Pick<
  Debugger,
  'attach' | 'detach' | 'isAttached' | 'sendCommand' | 'on' | 'removeListener'
>;

/** The guest page the relay serves: a `WebContents`, as far as the relay is concerned. */
export interface RelayGuest {
  readonly debugger: RelayDebugger;
  getUserAgent(): string;
}

export interface CdpRelayOptions {
  /** Called once, when the relay closes for any reason, `close()` included. */
  onClose?: (reason: string) => void;
  /** Tests lower these; the defaults are the ceilings above. */
  maxQueuedBytes?: number;
  maxMessageBytes?: number;
}

/** Hosts a request on this machine may name. A web page's DNS name never matches. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Why a WebSocket upgrade is refused, as an HTTP status, or undefined to let
 * it through. A browser always sends `Origin` on a WebSocket handshake, so no
 * web page (the person's own pages included) can ever connect, and a `Host`
 * other than loopback on this port is a DNS-rebinding attempt or a request
 * meant for someone else. The path must be the secret exactly.
 */
export function refuseUpgrade(
  request: Pick<http.IncomingMessage, 'url' | 'headers'>,
  expected: { path: string; port: number },
): 403 | 404 | undefined {
  const { headers } = request;
  // Sec-WebSocket-Origin is what the handshake's older version 8 sends instead.
  if (headers.origin !== undefined || headers['sec-websocket-origin'] !== undefined) return 403;
  if (!isLoopbackHost(headers.host, expected.port)) return 403;
  if (!samePath(request.url, expected.path)) return 404;
  return undefined;
}

function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const colon = host.lastIndexOf(':');
  if (colon < 0) return false;
  return (
    LOOPBACK_NAMES.has(host.slice(0, colon).toLowerCase()) && host.slice(colon + 1) === String(port)
  );
}

/** Compared in constant time, so the secret cannot be guessed a character at a time. */
function samePath(url: string | undefined, path: string): boolean {
  const given = Buffer.from(url ?? '');
  const expected = Buffer.from(path);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function refuse(socket: Duplex, status: number): void {
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detachQuietly(pageDebugger: RelayDebugger): void {
  try {
    if (pageDebugger.isAttached()) pageDebugger.detach();
  } catch (error) {
    // A page destroyed under the relay has nothing left to detach.
    console.warn('Could not detach from the page:', messageOf(error));
  }
}

/**
 * Serves one guest page's `webContents.debugger` to `playwright-core`'s
 * `chromium.connectOverCDP(endpoint)`, so the agent's browser tools get
 * Playwright's element finding and waiting on top of a page the person can
 * see (spec decision 5).
 *
 * Whoever reaches this controls a page where the person may be signed in,
 * so it is shut tight:
 * - It listens on 127.0.0.1 only, on a port the OS picks, at a path holding
 *   24 random bytes. The address never leaves main: no tool returns it and no
 *   session's environment holds it. Consola never starts with
 *   `--remote-debugging-port`, which would expose every window, its own
 *   included.
 * - It refuses any upgrade with an `Origin` header, a non-loopback `Host` or
 *   a wrong path (`refuseUpgrade`), and answers plain HTTP with 404.
 * - It serves one client, once. A second connection is refused, and when the
 *   client leaves the relay closes, so nothing one connection set up on the
 *   page carries into another. A new connection means a new relay.
 * - What it has written but the client has not read is capped
 *   (`MAX_QUEUED_BYTES`); past it the client is dropped, since dropping
 *   events instead would leave Playwright out of step with the page.
 *
 * The relay holds the page's one debugger attachment from `open` to `close`:
 * Electron allows a single client per page, and opening DevTools on the page
 * ends it (Electron emits `detach`), which closes the relay. Main can still
 * send its own commands through the same `webContents.debugger` meanwhile.
 * What CDP the relay speaks is `cdpRelayProtocol`'s.
 */
export class CdpRelay {
  /** Where Playwright connects. Stays in main. */
  public readonly endpoint: string;

  private readonly server: http.Server;
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_INBOUND_BYTES,
    perMessageDeflate: false,
    clientTracking: false,
  });
  private readonly path = `/${crypto.randomBytes(24).toString('base64url')}`;
  private readonly port: number;
  private readonly maxQueuedBytes: number;
  private client: WebSocket | undefined;
  private connection: RelayConnection | undefined;
  private served = false;
  private closed = false;
  /** Chromium ended the attachment itself, so there is nothing left to detach. */
  private dropped = false;

  /**
   * Attaches to the page's debugger and starts listening. Rejects, with
   * nothing left attached or listening, if the page cannot be debugged:
   * DevTools or another client already holds it, or the page is gone.
   */
  public static async open(guest: RelayGuest, options: CdpRelayOptions = {}): Promise<CdpRelay> {
    const pageDebugger = guest.debugger;
    if (pageDebugger.isAttached()) {
      throw new Error('Could not attach to the page: its debugger is already in use.');
    }
    try {
      pageDebugger.attach('1.3');
    } catch (error) {
      throw new Error(`Could not attach to the page: ${messageOf(error)}`);
    }
    const server = http.createServer((_request, response) => {
      response.writeHead(404, { Connection: 'close' });
      response.end();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        // Loopback only, never 0.0.0.0; port 0 lets the OS choose.
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      detachQuietly(pageDebugger);
      throw new Error(`Could not start the page's relay: ${messageOf(error)}`);
    }
    // The relay hears `detach` only once it exists, so an attachment that
    // ended while the server was starting (DevTools opened, the page closed)
    // is caught here instead.
    if (!pageDebugger.isAttached()) {
      server.close();
      throw new Error('Could not attach to the page: its debugger detached while starting.');
    }
    server.unref();
    return new CdpRelay(guest, server, options);
  }

  private constructor(
    private readonly guest: RelayGuest,
    server: http.Server,
    private readonly options: CdpRelayOptions,
  ) {
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    this.endpoint = `ws://127.0.0.1:${this.port}${this.path}`;
    this.maxQueuedBytes = options.maxQueuedBytes ?? MAX_QUEUED_BYTES;
    guest.debugger.on('message', this.onDebuggerMessage);
    guest.debugger.on('detach', this.onDebuggerDetach);
    server.on('upgrade', (request, socket, head) => this.onUpgrade(request, socket, head));
    server.on('error', (error) => this.close(`The relay failed: ${error.message}`));
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  /** Detaches from the page, drops the client and stops listening. Idempotent. */
  public close(reason = 'The relay was closed.'): void {
    if (this.closed) return;
    this.closed = true;
    this.connection?.close();
    const pageDebugger = this.guest.debugger;
    // The listeners come off first, so this detach never reads as Chromium's own.
    pageDebugger.removeListener('message', this.onDebuggerMessage);
    pageDebugger.removeListener('detach', this.onDebuggerDetach);
    if (!this.dropped) detachQuietly(pageDebugger);
    this.client?.terminate();
    this.sockets.close();
    this.server.close();
    this.server.closeAllConnections();
    this.options.onClose?.(reason);
  }

  private onUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    // A client that hangs up mid-handshake is no concern of the relay's.
    socket.on('error', () => {});
    if (this.closed) {
      socket.destroy();
      return;
    }
    const refusal = refuseUpgrade(request, { path: this.path, port: this.port });
    if (refusal !== undefined) {
      refuse(socket, refusal);
      return;
    }
    if (this.served) {
      refuse(socket, 409);
      return;
    }
    this.served = true;
    this.sockets.handleUpgrade(request, socket, head, (client) => this.accept(client));
  }

  private accept(client: WebSocket): void {
    if (this.closed) {
      client.terminate();
      return;
    }
    this.client = client;
    this.connection = createRelayConnection(
      this.page(),
      { write: (text) => this.write(text), fail: (reason) => this.close(reason) },
      this.options.maxMessageBytes ?? MAX_MESSAGE_BYTES,
    );
    client.on('message', (data: RawData, isBinary: boolean) => {
      // Playwright speaks text frames only.
      if (isBinary || !Buffer.isBuffer(data)) return;
      this.connection?.receive(data.toString('utf8'));
    });
    client.on('close', () => this.close('The client disconnected.'));
    client.on('error', (error) => this.close(`The connection failed: ${error.message}`));
  }

  private write(text: string): void {
    const client = this.client;
    if (this.closed || !client || client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > this.maxQueuedBytes) {
      this.close('The client fell behind the page, past what the relay will hold for it.');
      return;
    }
    client.send(text);
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
    this.connection?.event(method, params, sessionId);
  };

  private readonly onDebuggerDetach = (_event: unknown, reason: string): void => {
    this.dropped = true;
    this.close(`The page's debugger detached (${reason}).`);
  };
}
