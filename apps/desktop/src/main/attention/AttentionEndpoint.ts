import * as crypto from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { AttentionSignal } from './hookSignals';

/**
 * A ceiling on what one hook event may buffer in main's memory — not a size
 * a hook has to stay under. A `PostToolUse` carrying a whole file's
 * `tool_input` is an ordinary event, so the cap is far above anything a CLI
 * plausibly sends; a body past it is dropped (with a warning) rather than
 * refused, because the request has already been answered.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** A driver's reading of one hook payload: a signal, or null for an event that says nothing about attention. */
export type ParseHookEvent = (body: unknown) => AttentionSignal | null;

interface Registration {
  instanceId: string;
  parse: ParseHookEvent;
}

/**
* The loopback endpoint an agent CLI's hooks post to.
*
* Local IPC, not a service: it binds 127.0.0.1 only, on a port the OS picks
* for each launch of the app, and every terminal posts to a URL carrying its
* own random token. A request without a known token learns nothing and
* changes nothing. Hooks use HTTP rather than the MCP endpoint because the
* CLI's Notification hook does not wait for an MCP server that is still
* connecting, so the earliest events would vanish without a trace.
*
* It only hears and translates. What a signal means is `HookSignals`'.
*/
export class AttentionEndpoint {
  private readonly byToken = new Map<string, Registration>();
  private readonly tokenOf = new Map<string, string>();
  private server: http.Server | undefined;
  private port: Promise<number | undefined> | undefined;

  constructor(private readonly onSignal: (instanceId: string, signal: AttentionSignal) => void) {}

  /** Begin listening. Idempotent; resolves to the port, or undefined when it could not bind. */
  public start(): Promise<number | undefined> {
    this.port ??= new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', (error) => {
        console.error('The attention endpoint failed:', error);
        resolve(undefined);
      });
      // Loopback only, never 0.0.0.0; port 0 lets the OS choose.
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      server.unref();
      this.server = server;
    });
    return this.port;
  }

  /**
  * The URL this terminal's hooks should post to, or undefined when the
  * endpoint is not up (the session then runs on the screen heuristic alone).
  * The same instance keeps the same URL until `unregister`, so a relaunch in
  * place needs no new registration.
  */
  public async urlFor(instanceId: string, parse: ParseHookEvent): Promise<string | undefined> {
    const port = await this.start();
    if (port === undefined) return undefined;
    let token = this.tokenOf.get(instanceId);
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      this.tokenOf.set(instanceId, token);
    }
    this.byToken.set(token, { instanceId, parse });
    return `http://127.0.0.1:${port}/attention/${token}`;
  }

  public unregister(instanceId: string): void {
    const token = this.tokenOf.get(instanceId);
    if (token) this.byToken.delete(token);
    this.tokenOf.delete(instanceId);
  }

  public close(): void {
    this.server?.close();
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const reply = (status: number) => {
      res.writeHead(status);
      res.end();
    };
    const registration = this.registrationFor(req.url);
    // Unknown token and wrong method look the same: nothing to learn.
    if (!registration) return reply(401);
    if (req.method !== 'POST') return reply(405);

    // Answered the moment the token checks out, before a byte of the body is
    // read. Nothing in the reply depends on what the body says, and a CLI
    // waiting on a hook Consola injected must never wait on this process —
    // not for a parse, not for a listener, not for main's event loop. It also
    // leaves one reply per request, which is the only way to be sure a second
    // one can never be written to an ended response.
    reply(200);

    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Past the ceiling, stop buffering but keep draining: the answer is
      // already sent, so there is nothing to refuse, only a signal to lose.
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    // A hook that gives up mid-body is the CLI's business, not an error here.
    req.on('error', () => {});
    req.on('end', () => {
      if (oversized) {
        console.warn(`Ignored a hook event of ${size} bytes: larger than this endpoint will read.`);
        return;
      }
      try {
        const signal = registration.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (signal) this.onSignal(registration.instanceId, signal);
      } catch (error) {
        console.warn('Ignored an unreadable hook event:', error instanceof Error ? error.message : error);
      }
    });
  }

  private registrationFor(url: string | undefined): Registration | undefined {
    const match = /^\/attention\/([0-9a-f]{48})\/?$/.exec(url ?? '');
    return match ? this.byToken.get(match[1]) : undefined;
  }
}
