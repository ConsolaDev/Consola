import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import {
  type CellMessage,
  PASS_MAX_LIFETIME_SECONDS,
  type PassClaims,
  passClaims,
  readCellMessage,
  readPassClaims,
  type RunnerHello,
} from '@consola/runner-protocol';
import { Hono } from 'hono';
import { compactVerify, importSPKI } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { CloudSessionStore } from '../../application/ports.js';
import type { CloudSession, CloudSessionStatus } from '../../domain/cloudSession.js';
import { type Database, migrateDatabase, openDatabase } from '../persistence/database.js';
import { createCloudSessionStore } from '../persistence/cloudSessions.js';
import { createPassSigner, type PassKey } from '../token/passSigner.js';
import {
  createRunnerSocket,
  RUNNER_FRAME_LIMIT_BYTES,
  RUNNER_SOCKET_CLOSE,
  RUNNER_SOCKET_PATH,
  type RunnerSocket,
} from './runnerSocket.js';

/** `vi.waitFor` with a timeout in line with the suite's own, so a loaded machine does not flake. */
const waitFor = <T>(callback: () => T | Promise<T>) =>
  vi.waitFor(callback, { timeout: 10_000, interval: 25 });

/** A stand-in for the runner's shared secret, never a real one. */
const SECRET = 'sprocket-runner-secret-0123456789abcdef';

let db: Database;
let closeDatabase: () => Promise<void>;
let sessions: CloudSessionStore;
let passKey: PassKey;
let privateD: string;
let runner: RunnerSocket;
let server: ServerType;
let url: string;
let lines: string[];
/** Test hooks: what the store's `find` does before answering, and a throw the log may make. */
let afterFind: ((id: string, found: CloudSession | null) => Promise<void>) | null;
let reportHook: ((line: string) => void) | null;
const clients: WebSocket[] = [];

async function listen(socket: RunnerSocket): Promise<void> {
  const app = new Hono();
  app.route('/', socket.routes);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve());
    socket.injectWebSocket(server);
  });
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${RUNNER_SOCKET_PATH}`;
}

function build(settings: 'set' | 'unset' = 'set'): RunnerSocket {
  return createRunnerSocket({
    settings:
      settings === 'set'
        ? { secret: SECRET, workspaceId: 'acme', passPublicKeyPem: passKey.publicKeyPem }
        : null,
    ports: {
      sessions: {
        ...sessions,
        find: async (id: string) => {
          const found = await sessions.find(id);
          await afterFind?.(id, found);
          return found;
        },
      },
      clock: { nowSeconds: () => 2000 },
    },
    report: (line) => {
      reportHook?.(line);
      lines.push(line);
    },
  });
}

beforeEach(async () => {
  ({ db, close: closeDatabase } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  sessions = createCloudSessionStore(db);
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  privateD = String(jwk.d);
  passKey = await createPassSigner(jwk as Record<string, unknown>);
  lines = [];
  afterFind = null;
  reportHook = null;
  runner = build();
  await listen(runner);
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  runner.closeAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDatabase();
  // Nothing the cell logged, whatever a test did, holds the secret or the pass key.
  const logged = lines.join('\n');
  expect(logged).not.toContain(SECRET);
  expect(logged).not.toContain(privateD);
});

/** A runner's socket, as the runner opens it, and what the cell sends it. */
type Runner = {
  socket: WebSocket;
  received: CellMessage[];
  closed: Promise<number>;
  send(message: unknown): void;
};

function open(secret = SECRET): Promise<Runner> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${secret}` } });
  clients.push(socket);
  const received: CellMessage[] = [];
  socket.on('message', (data) => {
    const read = readCellMessage(JSON.parse(String(data)));
    if (!read.ok) throw new Error(`the cell sent what a runner cannot read: ${read.reason}`);
    received.push(read.value);
  });
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    socket.once('open', () =>
      resolve({
        socket,
        received,
        closed,
        send: (message) => socket.send(JSON.stringify(message)),
      }),
    );
    socket.once('error', reject);
  });
}

/** The status the cell answers an upgrade with, when it refuses one. */
function refusal(headers: Record<string, string>): Promise<number> {
  const socket = new WebSocket(url, { headers });
  clients.push(socket);
  // Ending a refused socket, still connecting, is an error the test expects.
  socket.on('error', () => {});
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
    socket.once('open', () => reject(new Error('the cell took the socket')));
  });
}

const hello = (over: Partial<RunnerHello> = {}): RunnerHello => ({
  type: 'hello',
  runnerId: 'runner-1',
  repositories: ['sprocket/catalog-portal'],
  harnesses: ['claude'],
  runningSessionIds: [],
  endedSessions: [],
  automations: false,
  ...over,
});

/** Opens a runner's socket and says hello, once the cell has taken it. */
async function connect(over: Partial<RunnerHello> = {}, secret = SECRET): Promise<Runner> {
  const opened = await open(secret);
  opened.send(hello(over));
  await waitFor(() =>
    expect(runner.channel.connected('acme')?.runnerId).toBe(hello(over).runnerId),
  );
  return opened;
}

async function holds(id: string, status: CloudSessionStatus, over: Partial<CloudSession> = {}) {
  await sessions.insert({
    id,
    workspaceId: 'acme',
    personId: 'person-1',
    repository: 'sprocket/catalog-portal',
    harness: 'claude',
    status,
    title: null,
    hostUrl: status === 'running' ? 'https://3000-sandbox.e2b.example' : null,
    error: null,
    errorCode: null,
    runnerId: 'runner-1',
    createdAt: 1000,
    endedAt: status === 'stopped' || status === 'failed' ? 1500 : null,
    ...over,
  });
}

const start = {
  sessionId: 's-1',
  workspaceId: 'acme',
  repository: 'sprocket/catalog-portal',
  harness: 'claude',
} as const;

describe('the runner socket', () => {
  describe('the secret', () => {
    it('refuses a socket with no secret, or any other, with 401 before the upgrade', async () => {
      const wrongLength = `${SECRET}-and-more`;
      const sameLength = `${SECRET.slice(0, -1)}${SECRET.endsWith('f') ? 'e' : 'f'}`;
      expect(sameLength).toHaveLength(SECRET.length);

      expect(await refusal({})).toBe(401);
      expect(await refusal({ authorization: `Bearer ${sameLength}` })).toBe(401);
      expect(await refusal({ authorization: `Bearer ${wrongLength}` })).toBe(401);
      expect(await refusal({ authorization: `Basic ${SECRET}` })).toBe(401);
      expect(await refusal({ authorization: SECRET })).toBe(401);
      expect(runner.channel.connected('acme')).toBeNull();
    });

    it('refuses every socket when no secret is set, so no runner connects', async () => {
      runner.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runner = build('unset');
      await listen(runner);

      expect(await refusal({ authorization: `Bearer ${SECRET}` })).toBe(401);
      expect(await refusal({})).toBe(401);
      expect(runner.channel.connected('acme')).toBeNull();
      await expect(runner.channel.startSession('runner-1', start)).rejects.toThrow();
    });

    it('answers a request that is no upgrade over plain HTTP, without a socket', async () => {
      const http = url.replace('ws:', 'http:');
      const bare = await fetch(http);
      expect(bare.status).toBe(401);
      expect(await bare.json()).toEqual({ error: 'runner_refused' });
      const plain = await fetch(http, { headers: { authorization: `Bearer ${SECRET}` } });
      expect(plain.status).toBe(426);
    });

    it('is never in what the cell answers or logs', async () => {
      const wrong = `${SECRET}-but-wrong`;
      const response = await fetch(url.replace('ws:', 'http:'), {
        headers: { authorization: `Bearer ${wrong}` },
      });
      const body = await response.text();
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain(wrong);
      expect(lines.join('\n')).not.toContain(wrong);
    });
  });

  describe('connected', () => {
    it('is the offer of the hello, until the socket closes, and only for its workspace', async () => {
      const opened = await open();
      expect(runner.channel.connected('acme')).toBeNull();
      opened.send(hello({ repositories: ['sprocket/catalog-portal', 'sprocket/billing'] }));
      await waitFor(() =>
        expect(runner.channel.connected('acme')).toEqual({
          runnerId: 'runner-1',
          repositories: ['sprocket/catalog-portal', 'sprocket/billing'],
          harnesses: ['claude'],
        }),
      );
      expect(runner.channel.connected('globex')).toBeNull();

      opened.socket.close();
      await waitFor(() => expect(runner.channel.connected('acme')).toBeNull());
      expect(runner.channel.connected('globex')).toBeNull();
    });

    it('is null for every workspace while no runner has said hello', () => {
      expect(runner.channel.connected('acme')).toBeNull();
      expect(runner.channel.connected('globex')).toBeNull();
    });
  });

  describe('startSession', () => {
    it("sends one session.start carrying the pass key's public half, which checks a pass", async () => {
      const connected = await connect();
      await runner.channel.startSession('runner-1', start);
      await waitFor(() => expect(connected.received).toHaveLength(1));

      const [message] = connected.received;
      if (message?.type !== 'session.start') throw new Error('expected a session.start');
      expect(message).toEqual({
        type: 'session.start',
        ...start,
        passPublicKeyPem: passKey.publicKeyPem,
      });
      expect(JSON.stringify(message)).not.toContain(privateD);

      // It reads back as an SPKI key, and verifies a pass the signer made.
      const key = await importSPKI(message.passPublicKeyPem, 'EdDSA');
      const claims: PassClaims = passClaims({
        personId: 'person-1',
        workspaceId: 'acme',
        sessionId: 's-1',
        issuedAt: 2000,
        lifetimeSeconds: PASS_MAX_LIFETIME_SECONDS,
      });
      const verified = await compactVerify(await passKey.signer.sign(claims), key, {
        algorithms: ['EdDSA'],
      });
      expect(readPassClaims(JSON.parse(new TextDecoder().decode(verified.payload)))).toEqual({
        ok: true,
        value: claims,
      });
    });

    it('refuses a start for another runner or workspace, or with no runner connected', async () => {
      await expect(runner.channel.startSession('runner-1', start)).rejects.toThrow();
      const connected = await connect();
      await expect(runner.channel.startSession('runner-2', start)).rejects.toThrow();
      await expect(
        runner.channel.startSession('runner-1', { ...start, workspaceId: 'globex' }),
      ).rejects.toThrow();
      await expect(runner.channel.stopSession('runner-2', 's-1')).rejects.toThrow();
      expect(connected.received).toEqual([]);
    });

    it('sends a stop to the runner', async () => {
      const connected = await connect();
      await runner.channel.stopSession('runner-1', 's-1');
      await waitFor(() =>
        expect(connected.received).toEqual([{ type: 'session.stop', sessionId: 's-1' }]),
      );
    });
  });

  describe('hello', () => {
    it("fails the runner's live sessions it no longer lists, and keeps the listed", async () => {
      await holds('s-1', 'running');
      await holds('s-2', 'running');
      await connect({ runningSessionIds: ['s-1'] });

      expect(await sessions.find('s-2')).toMatchObject({
        status: 'failed',
        errorCode: 'runner_restarted',
      });
      expect(await sessions.find('s-1')).toMatchObject({ status: 'running' });
    });

    it('keeps the real end of a session that ended while the socket was down', async () => {
      await holds('s-5', 'running');
      await connect({
        endedSessions: [
          { sessionId: 's-5', status: 'failed', error: 'The sandbox ran out of memory.' },
        ],
      });
      expect(await sessions.find('s-5')).toMatchObject({
        status: 'failed',
        error: 'The sandbox ran out of memory.',
        errorCode: null,
      });
    });

    it('sends a session.stop for each listed session the cell holds as ended, or does not know', async () => {
      await holds('s-3', 'stopped');
      const connected = await connect({ runningSessionIds: ['s-3', 's-4'] });
      await waitFor(() =>
        expect(connected.received).toEqual([
          { type: 'session.stop', sessionId: 's-3' },
          { type: 'session.stop', sessionId: 's-4' },
        ]),
      );
    });

    it('still stops a session a person ended while the hello was judged', async () => {
      await holds('s-5', 'running');
      let first = true;
      // The person's stop commits after the judgement read s-5 as live and before the socket is
      // ready, so nothing is sent for it from the stop's own side.
      afterFind = async (id, found) => {
        if (id !== 's-5' || !first || found?.status !== 'running') return;
        first = false;
        await sessions.update('s-5', 'running', { status: 'stopped', endedAt: 1800 });
      };
      const connected = await connect({ runningSessionIds: ['s-5'] });
      await waitFor(() =>
        expect(connected.received).toContainEqual({ type: 'session.stop', sessionId: 's-5' }),
      );
    });

    it('is not offered to a person until the sessions it lists are judged', async () => {
      await holds('s-2', 'running');
      const opened = await open();
      opened.send(hello());
      // The moment the offer is out, the restart has already been applied.
      await waitFor(() => expect(runner.channel.connected('acme')).not.toBeNull());
      expect(await sessions.find('s-2')).toMatchObject({ status: 'failed' });
    });

    it('from a second socket replaces the first, which closes', async () => {
      const first = await connect({ runnerId: 'runner-1' });
      const second = await connect({ runnerId: 'runner-1', harnesses: ['claude', 'codex'] });

      expect(await first.closed).toBe(RUNNER_SOCKET_CLOSE.replaced);
      expect(runner.channel.connected('acme')).toMatchObject({ harnesses: ['claude', 'codex'] });
      await runner.channel.startSession('runner-1', start);
      await waitFor(() => expect(second.received).toHaveLength(1));
      expect(first.received).toEqual([]);
      // The first socket's close does not take the second's place away.
      expect(runner.channel.connected('acme')).not.toBeNull();
    });

    it('is taken once: a second hello on one socket is dropped, and logged', async () => {
      const connected = await connect();
      connected.send(hello({ harnesses: ['codex'] }));
      await waitFor(() => expect(lines.join('\n')).toMatch(/second hello/));
      expect(runner.channel.connected('acme')).toMatchObject({ harnesses: ['claude'] });
    });
  });

  describe('session.update', () => {
    it('reaches applyRunnerUpdate', async () => {
      await holds('s-1', 'starting');
      const connected = await connect({ runningSessionIds: ['s-1'] });
      connected.send({
        type: 'session.update',
        sessionId: 's-1',
        status: 'running',
        hostUrl: 'https://3000-sandbox.e2b.example',
      });
      connected.send({ type: 'session.update', sessionId: 's-1', title: 'Fix the cart total' });
      await waitFor(async () =>
        expect(await sessions.find('s-1')).toMatchObject({
          status: 'running',
          hostUrl: 'https://3000-sandbox.e2b.example',
          title: 'Fix the cart total',
        }),
      );
    });

    it('that cannot be read is logged with its reason alone, and dropped, keeping the socket', async () => {
      await holds('s-1', 'starting');
      const connected = await connect({ runningSessionIds: ['s-1'] });
      connected.send({
        type: 'session.update',
        sessionId: 's-1',
        status: 'exploded',
        title: 'what-the-frame-held',
      });
      connected.socket.send('not json, but what-the-frame-held');
      await waitFor(() => expect(lines).toHaveLength(2));
      expect(lines[0]).toMatch(/`status` is not a session status/);
      expect(lines[1]).toMatch(/not JSON/);
      expect(lines.join('\n')).not.toContain('what-the-frame-held');
      expect(await sessions.find('s-1')).toMatchObject({ status: 'starting', title: null });

      // Still open: the next update applies.
      connected.send({ type: 'session.update', sessionId: 's-1', status: 'running' });
      await waitFor(async () =>
        expect(await sessions.find('s-1')).toMatchObject({ status: 'running' }),
      );
      expect(connected.socket.readyState).toBe(WebSocket.OPEN);
    });

    it('for runs, which the cell does not act on yet, is logged by its type and dropped, keeping the socket', async () => {
      await holds('s-1', 'starting');
      const connected = await connect({ runningSessionIds: ['s-1'], automations: true });
      connected.send({ type: 'factories.request', requestId: 'what-the-frame-held' });
      connected.send({ type: 'github.event.ack', deliveryId: 'what-the-frame-held' });
      connected.send({
        type: 'github.token.request',
        requestId: 'req-1',
        runId: 'what-the-frame-held',
        stepId: 'review',
        repository: 'sprocket/catalog-portal',
        permissions: { contents: 'read' },
      });
      await waitFor(() => expect(lines).toHaveLength(3));
      expect(lines[0]).toMatch(/`factories.request`, which it does not act on yet/);
      expect(lines[1]).toMatch(/`github.event.ack`/);
      expect(lines[2]).toMatch(/`github.token.request`/);
      expect(lines.join('\n')).not.toContain('what-the-frame-held');

      // Still open: the next update applies.
      connected.send({ type: 'session.update', sessionId: 's-1', status: 'running' });
      await waitFor(async () =>
        expect(await sessions.find('s-1')).toMatchObject({ status: 'running' }),
      );
      expect(connected.socket.readyState).toBe(WebSocket.OPEN);
    });

    it('before hello is dropped, and logged', async () => {
      await holds('s-1', 'starting');
      const opened = await open();
      opened.send({ type: 'session.update', sessionId: 's-1', status: 'running' });
      await waitFor(() => expect(lines.join('\n')).toMatch(/before its hello/));
      expect(await sessions.find('s-1')).toMatchObject({ status: 'starting' });
    });

    /**
     * Holds the next update's read of `s-1` until the returned `release`, so the updates sent
     * after it wait in the socket's queue; `held` settles once that read is held.
     */
    function holdNextUpdate() {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markHeld = () => {};
      const held = new Promise<void>((resolve) => {
        markHeld = resolve;
      });
      let armed = true;
      afterFind = async (id) => {
        if (id !== 's-1' || !armed) return;
        armed = false;
        markHeld();
        await gate;
      };
      return { held, release };
    }

    /** A runner holding `s-1` running, its hello and a first update on its socket applied. */
    async function runningOnSocket(): Promise<Runner> {
      await holds('s-1', 'running');
      const connected = await connect({ runningSessionIds: ['s-1'] });
      // Once this applies, the hello is wholly handled and the socket's queue is empty.
      connected.send({ type: 'session.update', sessionId: 's-1', title: 'Before' });
      await waitFor(async () =>
        expect(await sessions.find('s-1')).toMatchObject({ title: 'Before' }),
      );
      return connected;
    }

    it('received before its socket closed still applies, though no socket replaced it', async () => {
      const connected = await runningOnSocket();
      const { held, release } = holdNextUpdate();
      connected.send({ type: 'session.update', sessionId: 's-1', title: 'Fix the cart total' });
      // The runner's end, said as it stops: it waits in the queue behind the held update.
      connected.send({ type: 'session.update', sessionId: 's-1', status: 'stopped' });
      await held;
      connected.socket.close(1001, 'the runner is stopping');
      await waitFor(() => expect(runner.channel.connected('acme')).toBeNull());
      release();

      await waitFor(async () =>
        expect(await sessions.find('s-1')).toMatchObject({
          status: 'stopped',
          title: 'Fix the cart total',
        }),
      );
      expect(lines.join('\n')).not.toMatch(/no longer serves/);
    });

    /** Settles once the cell has read every frame `runner` sent so far: a ping's pong follows them. */
    function readByCell({ socket }: Runner): Promise<void> {
      return new Promise((resolve) => {
        socket.once('pong', () => resolve());
        socket.ping();
      });
    }

    /** Long enough for a hello judged out of turn to have failed `s-1` and been offered. */
    const OUT_OF_TURN_MS = 200;

    it("received before its socket closed applies before a later socket's hello is judged", async () => {
      const first = await runningOnSocket();
      const { held, release } = holdNextUpdate();
      first.send({ type: 'session.update', sessionId: 's-1', title: 'Fix the cart total' });
      // The runner's end, said as it stops, waits in the queue behind the held update.
      first.send({ type: 'session.update', sessionId: 's-1', status: 'stopped' });
      await held;
      first.socket.close(1001, 'the runner is stopping');
      await waitFor(() => expect(runner.channel.connected('acme')).toBeNull());
      // The runner again, on a new socket and holding nothing: its hello waits for that end.
      const second = await open();
      second.send(hello({ runningSessionIds: [] }));
      await readByCell(second);
      await new Promise((resolve) => setTimeout(resolve, OUT_OF_TURN_MS));
      expect(runner.channel.connected('acme')).toBeNull();
      expect(await sessions.find('s-1')).toMatchObject({ status: 'running' });
      release();

      await waitFor(() => expect(runner.channel.connected('acme')?.runnerId).toBe('runner-1'));
      // The end the runner said stands: never the restart its hello would otherwise mean.
      expect(await sessions.find('s-1')).toMatchObject({
        status: 'stopped',
        error: null,
        errorCode: null,
        title: 'Fix the cart total',
      });
    });

    it("received on a replaced socket after the new socket's hello is dropped, and logged", async () => {
      const first = await runningOnSocket();
      const { held, release } = holdNextUpdate();
      // Received before the second socket's hello: it applies.
      first.send({ type: 'session.update', sessionId: 's-1', title: 'Fix the cart total' });
      await held;
      // The second socket's hello takes the workspace, and lists s-1 as still running.
      const second = await open();
      second.send(hello({ runningSessionIds: ['s-1'], harnesses: ['claude', 'codex'] }));
      await readByCell(second);
      // Received after it: by its turn, the second socket serves the workspace.
      first.send({ type: 'session.update', sessionId: 's-1', status: 'stopped' });
      await readByCell(first);
      release();

      expect(await first.closed).toBe(RUNNER_SOCKET_CLOSE.replaced);
      await waitFor(() => expect(lines.join('\n')).toMatch(/no longer serves/));
      expect(runner.channel.connected('acme')).toMatchObject({ harnesses: ['claude', 'codex'] });
      expect(await sessions.find('s-1')).toMatchObject({
        status: 'running',
        title: 'Fix the cart total',
      });
    });
  });

  describe('a handler that fails', () => {
    it('does not stop the next message, nor leave an unhandled rejection', async () => {
      const rejections: unknown[] = [];
      const note = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', note);
      try {
        await holds('s-6', 'running');
        let throwOnce = true;
        reportHook = () => {
          if (!throwOnce) return;
          throwOnce = false;
          throw new Error('the log failed once');
        };
        const opened = await open();
        // An update before the hello is logged, and the log throws: the handler rejects.
        opened.send({ type: 'session.update', sessionId: 's-6', title: 'Early' });
        opened.send(hello({ runningSessionIds: ['s-6'] }));
        await waitFor(() => expect(runner.channel.connected('acme')?.runnerId).toBe('runner-1'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(rejections).toEqual([]);
        expect(lines.join('\n')).toMatch(/could not handle a runner's message/);
        expect(lines.join('\n')).not.toContain('the log failed once"');
      } finally {
        process.off('unhandledRejection', note);
      }
    });
  });

  describe('frames', () => {
    it(`over ${RUNNER_FRAME_LIMIT_BYTES} bytes close the socket with 1009`, async () => {
      const connected = await connect();
      connected.socket.send('x'.repeat(RUNNER_FRAME_LIMIT_BYTES + 1));
      expect(await connected.closed).toBe(1009);
      await waitFor(() => expect(runner.channel.connected('acme')).toBeNull());
    });

    it('up to the limit are read', async () => {
      await holds('s-1', 'starting');
      const connected = await connect({ runningSessionIds: ['s-1'] });
      const update = { type: 'session.update', sessionId: 's-1', title: '' };
      const room = RUNNER_FRAME_LIMIT_BYTES - JSON.stringify(update).length;
      connected.send({ ...update, title: 't'.repeat(room) });
      await waitFor(async () => expect((await sessions.find('s-1'))?.title).toHaveLength(room));
    });
  });

  it('closeAll closes every runner socket as the cell shuts down', async () => {
    const connected = await connect();
    runner.closeAll();
    expect(await connected.closed).toBe(RUNNER_SOCKET_CLOSE.shuttingDown);
    await waitFor(() => expect(runner.channel.connected('acme')).toBeNull());
  });
});
