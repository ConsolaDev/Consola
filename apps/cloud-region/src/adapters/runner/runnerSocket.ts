import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type CellMessage,
  type ReadResult,
  type RunnerHello,
  type RunnerMessage,
  readRunnerMessage,
  type SessionUpdate,
} from '@consola/runner-protocol';
import { createNodeWebSocket, type NodeWebSocket } from '@hono/node-ws';
import { type Context, Hono } from 'hono';
import type { WSContext, WSEvents } from 'hono/ws';
import { applyRunnerUpdate } from '../../application/cloudSessions.js';
import type {
  Offer,
  RunnerChannel,
  RunnerUpdatePorts,
  SessionStartRequest,
} from '../../application/ports.js';
import { runnerConnected } from '../../application/runners.js';
import { noRunner } from './noRunner.js';

/** Where a workspace's runner opens its socket, with `Authorization: Bearer <RUNNER_SECRET>`. */
export const RUNNER_SOCKET_PATH = '/api/runner';

/**
 * The largest frame a runner may send, in bytes: room for a `hello` listing many sessions and an
 * update carrying a long error, and no more. Past it the socket closes with 1009 (Message Too
 * Big) before the frame is read, so a runner cannot fill the cell's memory one frame at a time.
 */
export const RUNNER_FRAME_LIMIT_BYTES = 64 * 1024;

/** Why the cell closes a runner's socket. A runner reconnects after either. */
export const RUNNER_SOCKET_CLOSE = {
  /** Another socket of the same runner said hello, and serves the workspace now. */
  replaced: 4000,
  /** The cell is stopping (1001, Going Away). */
  shuttingDown: 1001,
  /** The cell could not judge the runner's hello (1011, Internal Error): its next one is. */
  helloFailed: 1011,
} as const;

/** The POC's stand-in for enrolment (epic 13): one secret, one workspace, one pass key. */
export type RunnerSocketSettings = {
  /** The shared secret a runner presents. It is compared as a hash, and never logged. */
  secret: string;
  /** The one workspace the runner serves, whatever its `hello` says of itself. */
  workspaceId: string;
  /** The public half of the pass key, sent in every `session.start`. A public key, never a secret. */
  passPublicKeyPem: string;
};

export type RunnerSocket = {
  /** The `RunnerChannel` the use cases reach the runner through. */
  channel: RunnerChannel;
  /** `GET RUNNER_SOCKET_PATH`, for `createApp` to mount before `requireCaller`. */
  routes: Hono;
  /** Hands the server's upgrades to the socket. Every upgrade goes to `routes`, and only it. */
  injectWebSocket: NodeWebSocket['injectWebSocket'];
  /** Closes every runner's socket, for a cell that is stopping: a server waits on open sockets. */
  closeAll(): void;
};

/** One runner's socket, from its upgrade to its close. */
type Connection = {
  socket: WSContext | null;
  /** What its `hello` offered. Null until it says hello. */
  offer: Offer | null;
  /** True once its `hello` is judged: only then does the channel offer it to a person. */
  ready: boolean;
  closed: boolean;
  /** Its messages are handled one after another, in the order they came. */
  queue: Promise<void>;
};

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** The first line of an error and of each of its causes, for the log. */
function describe(error: unknown): string {
  const lines: string[] = [];
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 3; depth += 1) {
    const line = current.message.split('\n')[0]?.trim();
    if (line) lines.push(line);
    current = current.cause;
  }
  return lines.join(': ') || 'an unexpected error';
}

/** What a frame holds, read as the protocol has it: text, JSON, and a runner message. */
function readFrame(data: unknown): ReadResult<RunnerMessage> {
  if (typeof data !== 'string') return { ok: false, reason: 'it is not text' };
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return { ok: false, reason: 'it is not JSON' };
  }
  return readRunnerMessage(json);
}

/**
 * The runner's connection: `GET RUNNER_SOCKET_PATH`, upgraded to a WebSocket (`@hono/node-ws`)
 * once the runner's secret is checked, and the `RunnerChannel` over it.
 *
 * - **The secret** is compared in constant time, as SHA-256 hashes, so neither its contents nor
 *   its length shows in how long a refusal takes. Anything else (no header, another scheme, a
 *   wrong secret, or none configured) is 401 before the upgrade. Neither secret is ever logged.
 * - **One workspace.** The runner serves `settings.workspaceId` alone; its `hello` names only
 *   itself. A second socket's `hello` replaces the first, which closes (`replaced`).
 * - **`hello` first**, judged by `runnerConnected` before the offer is out, so no person's start
 *   lands among the sessions it judges. Then each `session.stop` it asks for is sent.
 * - **Updates** reach `applyRunnerUpdate`, one at a time in order. What cannot be read is logged
 *   with its reason alone, never the frame, and dropped; the socket stays open.
 *
 * With `settings` null (no runner configured), every request is 401 and no runner connects.
 */
export function createRunnerSocket(deps: {
  settings: RunnerSocketSettings | null;
  ports: RunnerUpdatePorts;
  report?: (line: string) => void;
}): RunnerSocket {
  const { settings, ports } = deps;
  const report = deps.report ?? ((line: string) => console.error(line));
  const routes = new Hono();
  const nodeWebSocket = createNodeWebSocket({ app: routes });
  // `@hono/node-ws` makes its server with ws's own limit, 100 MiB; ws reads this at each upgrade.
  nodeWebSocket.wss.options.maxPayload = RUNNER_FRAME_LIMIT_BYTES;

  const open = new Set<Connection>();
  /** The newest socket that said hello: the one that serves the workspace, once it is ready. */
  let latest: Connection | null = null;

  const secretDigest = settings ? digest(settings.secret) : null;
  const admits = (authorization: string | undefined): boolean => {
    if (!secretDigest) return false;
    const presented = /^Bearer (\S+)$/i.exec(authorization ?? '')?.[1];
    // Compared even when nothing was presented, so a refusal takes as long either way.
    const matches = timingSafeEqual(digest(presented ?? ''), secretDigest);
    return matches && presented !== undefined;
  };

  function send(connection: Connection, message: CellMessage): void {
    if (connection.closed || connection.socket?.readyState !== 1) {
      throw new Error("the runner's socket is not open");
    }
    connection.socket.send(JSON.stringify(message));
  }

  function close(connection: Connection, code: number, reason: string): void {
    if (latest === connection) latest = null;
    connection.socket?.close(code, reason);
  }

  /** The runner's ready socket, if it is `runnerId`'s. */
  const readyFor = (runnerId: string): Connection | null =>
    latest?.ready && latest.offer?.runnerId === runnerId ? latest : null;

  async function hello(
    connection: Connection,
    message: RunnerHello,
    { workspaceId }: RunnerSocketSettings,
  ) {
    if (connection.offer) {
      report("The cell dropped a second hello on one runner's socket.");
      return;
    }
    connection.offer = {
      runnerId: message.runnerId,
      repositories: [...message.repositories],
      harnesses: [...message.harnesses],
    };
    // From now on this socket is the runner's: an older one is closed, and no start goes out
    // until the sessions the hello lists are judged.
    const previous = latest;
    latest = connection;
    if (previous && previous !== connection) {
      close(previous, RUNNER_SOCKET_CLOSE.replaced, 'another socket of the runner said hello');
    }

    let stop: string[];
    try {
      ({ stop } = await runnerConnected(ports, workspaceId, message));
    } catch (error) {
      report(`The cell could not judge a runner's hello: ${describe(error)}`);
      close(connection, RUNNER_SOCKET_CLOSE.helloFailed, 'the cell could not judge the hello');
      return;
    }
    if (connection.closed || latest !== connection) return;
    try {
      for (const sessionId of stop) send(connection, { type: 'session.stop', sessionId });
    } catch {
      // Closed meanwhile: its next hello lists the same sessions, and is answered again.
      return;
    }
    connection.ready = true;
  }

  async function update(
    connection: Connection,
    message: SessionUpdate,
    { workspaceId }: RunnerSocketSettings,
  ) {
    if (!connection.offer) {
      report("The cell dropped a runner's update sent before its hello.");
      return;
    }
    if (latest !== connection || !connection.ready) {
      report("The cell dropped an update from a runner's socket that no longer serves it.");
      return;
    }
    try {
      await applyRunnerUpdate(ports, { workspaceId, runnerId: connection.offer.runnerId }, message);
    } catch (error) {
      report(`The cell could not apply a runner's update: ${describe(error)}`);
    }
  }

  function events(settings: RunnerSocketSettings): WSEvents {
    const connection: Connection = {
      socket: null,
      offer: null,
      ready: false,
      closed: false,
      queue: Promise.resolve(),
    };
    return {
      onOpen: (_event, socket) => {
        connection.socket = socket;
        open.add(connection);
      },
      onMessage: (event, socket) => {
        connection.socket = socket;
        const read = readFrame(event.data);
        if (!read.ok) {
          report(`The cell dropped a runner's message: ${read.reason}.`);
          return;
        }
        const message = read.value;
        connection.queue = connection.queue.then(() =>
          message.type === 'hello'
            ? hello(connection, message, settings)
            : update(connection, message, settings),
        );
      },
      onClose: () => {
        connection.closed = true;
        open.delete(connection);
        if (latest === connection) latest = null;
      },
      onError: (event) => {
        report(`A runner's socket failed: ${describe((event as { error?: unknown }).error)}`);
      },
    };
  }

  routes.get(RUNNER_SOCKET_PATH, (c: Context) => {
    if (!settings || !admits(c.req.header('authorization'))) {
      return c.json({ error: 'runner_refused' }, 401, { 'WWW-Authenticate': 'Bearer' });
    }
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'upgrade_required' }, 426, { Upgrade: 'websocket' });
    }
    return nodeWebSocket.upgradeWebSocket(c, events(settings), {
      onError: (error) => report(`A runner's socket handler failed: ${describe(error)}`),
    });
  });

  const channel: RunnerChannel = settings
    ? {
        connected(workspaceId) {
          const offer = latest?.ready ? latest.offer : null;
          if (workspaceId !== settings.workspaceId || !offer) return null;
          return {
            runnerId: offer.runnerId,
            repositories: [...offer.repositories],
            harnesses: [...offer.harnesses],
          };
        },
        async startSession(runnerId, request: SessionStartRequest) {
          const connection = readyFor(runnerId);
          if (!connection || request.workspaceId !== settings.workspaceId) {
            throw new Error('no such runner is connected');
          }
          send(connection, {
            type: 'session.start',
            sessionId: request.sessionId,
            workspaceId: request.workspaceId,
            repository: request.repository,
            harness: request.harness,
            passPublicKeyPem: settings.passPublicKeyPem,
          });
        },
        async stopSession(runnerId, sessionId) {
          const connection = readyFor(runnerId);
          if (!connection) throw new Error('no such runner is connected');
          send(connection, { type: 'session.stop', sessionId });
        },
      }
    : noRunner;

  return {
    channel,
    routes,
    injectWebSocket: (server) => nodeWebSocket.injectWebSocket(server),
    closeAll() {
      latest = null;
      for (const connection of open) {
        connection.socket?.close(RUNNER_SOCKET_CLOSE.shuttingDown, 'the cell is shutting down');
      }
    },
  };
}
