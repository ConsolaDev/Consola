// @effect-diagnostics nodeBuiltinImport:off - The test's cell listens on a port of this machine.
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CellMessage, SessionUpdate } from '@consola/runner-protocol';
import type * as Cause from 'effect/Cause';
import * as Deferred from 'effect/Deferred';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Queue from 'effect/Queue';
import type * as Scope from 'effect/Scope';
import { describe, expect, it } from 'vite-plus/test';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { LiveSessions } from './sandboxSessions.ts';
import { CELL_FRAME_LIMIT_BYTES, makeCellSocket } from './cellSocket.ts';
import type { CellSocket } from './cellSocket.ts';

const SECRET = 'runner-secret-sprocket-0123456789abcdef';
const OFFER = { repositories: ['sprocket/catalog-portal'], harnesses: ['claude' as const] };
const WAIT = Duration.seconds(10);

type Frame = Record<string, unknown>;

const json = (value: unknown): string => JSON.stringify(value);

/** One socket the test's cell accepted. */
type CellConnection = {
  readonly socket: WebSocket;
  readonly authorization: string | undefined;
  /** The next frame the runner sent on it, parsed; dies when none comes in time. */
  readonly next: Effect.Effect<Frame>;
  /** The payload of the next ping the runner sent on it; dies when none comes in time. */
  readonly pinged: Effect.Effect<string>;
  /** How the runner closed it, or the cell did. */
  readonly closed: Effect.Effect<number>;
};

type FakeCell = {
  readonly url: string;
  /** The next socket the runner opened; dies when none comes in time. */
  readonly next: Effect.Effect<CellConnection>;
  /** How many upgrades the runner asked for, refused ones included. */
  readonly attempts: () => number;
};

const timed = <A>(effect: Effect.Effect<A, Cause.Done>, what: string): Effect.Effect<A> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: WAIT,
      orElse: () => Effect.die(new Error(`no ${what} in time`)),
    }),
    Effect.orDie,
  );

/**
 * A cell on a free port of 127.0.0.1 that accepts the runner, or answers its upgrade `refuse`.
 * It answers the runner's pings, as `ws` does, unless `autoPong` is false: a socket that died
 * without a close looks that way to the runner.
 */
const fakeCell = (
  options: { readonly refuse?: number; readonly autoPong?: boolean } = {},
): Effect.Effect<FakeCell, never, Scope.Scope> =>
  Effect.gen(function* () {
    const connections = yield* Queue.unbounded<CellConnection, Cause.Done>();
    let attempts = 0;
    const server = yield* Effect.acquireRelease(
      Effect.callback<WebSocketServer>((resume) => {
        const wss: WebSocketServer = new WebSocketServer({
          host: '127.0.0.1',
          port: 0,
          autoPong: options.autoPong ?? true,
          verifyClient: (
            _info: { req: IncomingMessage },
            done: (ok: boolean, code?: number) => void,
          ) => {
            attempts += 1;
            if (options.refuse === undefined) done(true);
            else done(false, options.refuse);
          },
        });
        wss.on('listening', () => resume(Effect.succeed(wss)));
      }),
      (wss) =>
        Effect.callback<void>((resume) => {
          for (const client of wss.clients) client.terminate();
          wss.close(() => resume(Effect.void));
        }),
    );
    server.on('connection', (socket, request) => {
      // @effect-diagnostics-next-line runEffectInsideEffect:off - a ws listener, outside any fiber.
      const frames = Effect.runSync(Queue.unbounded<Frame, Cause.Done>());
      // @effect-diagnostics-next-line runEffectInsideEffect:off - a ws listener, outside any fiber.
      const pings = Effect.runSync(Queue.unbounded<string, Cause.Done>());
      const closed = Deferred.makeUnsafe<number>();
      socket.on('message', (data) => Queue.offerUnsafe(frames, JSON.parse(String(data)) as Frame));
      socket.on('ping', (data) => Queue.offerUnsafe(pings, data.toString('utf8')));
      socket.on('close', (code) => Deferred.doneUnsafe(closed, Effect.succeed(code)));
      Queue.offerUnsafe(connections, {
        socket,
        authorization: request.headers.authorization,
        next: timed(Queue.take(frames), 'frame from the runner'),
        pinged: timed(Queue.take(pings), 'ping from the runner'),
        closed: Deferred.await(closed).pipe(
          Effect.timeoutOrElse({
            duration: WAIT,
            orElse: () => Effect.die(new Error('the socket did not close in time')),
          }),
        ),
      });
    });
    const { port } = server.address() as AddressInfo;
    const cell: FakeCell = {
      url: `ws://127.0.0.1:${port}/api/runner`,
      next: timed(Queue.take(connections), 'connection from the runner'),
      attempts: () => attempts,
    };
    return cell;
  });

type Runner = {
  readonly socket: CellSocket;
  readonly received: Queue.Queue<CellMessage, Cause.Done>;
  readonly logged: string[];
  /** What the runner holds now, which `hello` reads. */
  live: LiveSessions;
};

/** A runner's socket to `cell`, dialling again after `delayMs`, closed with the test's scope. */
const runnerOf = (
  cell: FakeCell,
  delayMs = 50,
  onMessage?: (message: CellMessage) => Effect.Effect<void>,
  heartbeat?: { readonly intervalMs: number; readonly timeoutMs: number },
): Effect.Effect<Runner, never, Scope.Scope> =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<CellMessage, Cause.Done>();
    const logged: string[] = [];
    const socket = yield* Effect.acquireRelease(
      makeCellSocket({
        url: cell.url,
        secret: SECRET,
        runnerId: 'runner-sprocket-1',
        offer: OFFER,
        reconnectDelay: () => delayMs,
        ...(heartbeat === undefined ? {} : { heartbeat }),
        log: (message) => Effect.sync(() => logged.push(message)),
      }),
      (socket) => socket.close,
    );
    const runner: Runner = { socket, received, logged, live: { sessionIds: [], states: [] } };
    yield* socket.connect({
      live: () => runner.live,
      onMessage:
        onMessage ?? ((message) => Effect.sync(() => Queue.offerUnsafe(received, message))),
    });
    return runner;
  });

const run = <A>(effect: Effect.Effect<A, never, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

const running = (sessionId: string, title?: string): SessionUpdate => ({
  type: 'session.update',
  sessionId,
  status: 'running',
  hostUrl: `https://4100-${sessionId}.fake-sandbox.test`,
  ...(title === undefined ? {} : { title }),
});

describe('makeCellSocket', () => {
  it('dials the cell with its secret in the Authorization header, and says hello first', () =>
    run(
      Effect.gen(function* () {
        const cell = yield* fakeCell();
        const runner = yield* runnerOf(cell);
        runner.live = {
          sessionIds: ['session-acme-1', 'session-acme-2'],
          states: [running('session-acme-1', 'Sprocket catalog')],
        };
        const connection = yield* cell.next;
        expect(connection.authorization).toBe(`Bearer ${SECRET}`);
        expect(yield* connection.next).toEqual({
          type: 'hello',
          runnerId: 'runner-sprocket-1',
          repositories: ['sprocket/catalog-portal'],
          harnesses: ['claude'],
          runningSessionIds: ['session-acme-1', 'session-acme-2'],
          endedSessions: [],
        });
        expect(yield* connection.next).toEqual(running('session-acme-1', 'Sprocket catalog'));
        yield* runner.socket.send(running('session-acme-2'));
        expect(yield* connection.next).toEqual(running('session-acme-2'));
        expect(runner.logged.join('\n')).not.toContain(SECRET);
      }),
    ));

  it("hands on the cell's messages it reads, and drops the rest without closing", () =>
    run(
      Effect.gen(function* () {
        const cell = yield* fakeCell();
        const runner = yield* runnerOf(cell);
        const connection = yield* cell.next;
        yield* connection.next;
        connection.socket.send('not json');
        connection.socket.send(json({ type: 'session.restart', sessionId: 'x' }));
        connection.socket.send(Buffer.from([1, 2, 3]));
        const stop: CellMessage = { type: 'session.stop', sessionId: 'session-acme-3' };
        connection.socket.send(json(stop));
        expect(yield* timed(Queue.take(runner.received), 'message handed on')).toEqual(stop);
        expect(runner.logged.filter((line) => line.includes('dropped'))).toHaveLength(3);
        expect(cell.attempts()).toBe(1);
      }),
    ));

  it('dials again after the socket drops: hello lists the sessions still running and the ends it missed, then their state', () =>
    run(
      Effect.gen(function* () {
        const cell = yield* fakeCell();
        const runner = yield* runnerOf(cell, 300);
        runner.live = { sessionIds: ['session-acme-4'], states: [] };
        const first = yield* cell.next;
        yield* first.next;
        yield* runner.socket.send(running('session-acme-4'));
        expect(yield* first.next).toEqual(running('session-acme-4'));
        first.socket.terminate();
        yield* first.closed;

        // While it is down: a title is not queued (its state goes after the next hello), and an
        // end rides in the next hello.
        yield* runner.socket.send({
          type: 'session.update',
          sessionId: 'session-acme-4',
          title: 'Sprocket catalog',
        });
        yield* runner.socket.send({
          type: 'session.update',
          sessionId: 'session-acme-5',
          status: 'failed',
          error: 'Repository not found',
        });
        runner.live = {
          sessionIds: ['session-acme-4'],
          states: [running('session-acme-4', 'Sprocket catalog')],
        };

        const second = yield* cell.next;
        expect(yield* second.next).toMatchObject({
          type: 'hello',
          runningSessionIds: ['session-acme-4'],
          endedSessions: [
            { sessionId: 'session-acme-5', status: 'failed', error: 'Repository not found' },
          ],
        });
        expect(yield* second.next).toEqual(running('session-acme-4', 'Sprocket catalog'));
      }),
    ));

  it(
    'says again in the next hello an end whose ping got no answer, however long the socket stayed open',
    { timeout: 20_000 },
    () =>
      run(
        Effect.gen(function* () {
          const cell = yield* fakeCell({ autoPong: false });
          const runner = yield* runnerOf(cell);
          const first = yield* cell.next;
          yield* first.next;
          const stopped: SessionUpdate = {
            type: 'session.update',
            sessionId: 'session-acme-6',
            status: 'stopped',
          };
          yield* runner.socket.send(stopped);
          expect(yield* first.next).toEqual(stopped);
          // A socket that died without a close stays open for minutes: no time open means heard.
          yield* Effect.sleep(Duration.millis(5500));
          first.socket.terminate();
          const second = yield* cell.next;
          expect(yield* second.next).toMatchObject({
            type: 'hello',
            runningSessionIds: [],
            endedSessions: [{ sessionId: 'session-acme-6', status: 'stopped' }],
          });
        }),
      ),
  );

  it('does not say again an end the pong of its ping confirmed', () =>
    run(
      Effect.gen(function* () {
        const cell = yield* fakeCell();
        const runner = yield* runnerOf(cell);
        const first = yield* cell.next;
        yield* first.next;
        // The ping after hello, then the one after the end; ws answers each as it reads it.
        yield* first.pinged;
        const stopped: SessionUpdate = {
          type: 'session.update',
          sessionId: 'session-acme-6',
          status: 'stopped',
        };
        yield* runner.socket.send(stopped);
        expect(yield* first.next).toEqual(stopped);
        yield* first.pinged;
        // A close goes after the pong on the wire, so the runner has the pong first.
        first.socket.close(1012, 'the cell restarts');
        const second = yield* cell.next;
        expect(yield* second.next).toMatchObject({
          type: 'hello',
          runningSessionIds: [],
          endedSessions: [],
        });
      }),
    ));

  it('drops a socket whose cell stopped answering its pings, and dials again', () =>
    run(
      Effect.gen(function* () {
        const cell = yield* fakeCell({ autoPong: false });
        const runner = yield* runnerOf(cell, 20, undefined, { intervalMs: 100, timeoutMs: 200 });
        const first = yield* cell.next;
        expect(yield* first.next).toMatchObject({ type: 'hello' });
        expect(yield* first.pinged).toMatch(/^[1-9][0-9]*$/);
        expect(yield* first.closed).toBe(1006);
        const second = yield* cell.next;
        expect(yield* second.next).toMatchObject({ type: 'hello' });
        expect(runner.logged).toContain(
          'the cell did not answer a ping within 0.2 s; the socket is dropped',
        );
      }),
    ));

  it('never lists a session as running that it also says ended', () =>
    run(
      Effect.gen(function* () {
        const cell = yield* fakeCell();
        const runner = yield* runnerOf(cell);
        yield* runner.socket.send({
          type: 'session.update',
          sessionId: 'session-acme-7',
          status: 'stopped',
        });
        runner.live = { sessionIds: ['session-acme-7'], states: [running('session-acme-7')] };
        const connection = yield* cell.next;
        expect(yield* connection.next).toMatchObject({
          runningSessionIds: [],
          endedSessions: [{ sessionId: 'session-acme-7', status: 'stopped' }],
        });
      }),
    ));

  it("keeps a hello within the cell's frame limit, dropping the ends' messages when it must", () =>
    run(
      Effect.gen(function* () {
        const cell = yield* fakeCell();
        const runner = yield* runnerOf(cell);
        for (let each = 0; each < 32; each += 1) {
          yield* runner.socket.send({
            type: 'session.update',
            sessionId: `session-acme-long-${each}`,
            status: 'failed',
            error: '€'.repeat(1000),
          });
        }
        const connection = yield* cell.next;
        const hello = yield* connection.next;
        expect(Buffer.byteLength(json(hello))).toBeLessThanOrEqual(CELL_FRAME_LIMIT_BYTES);
        expect(hello.endedSessions).toHaveLength(32);
        expect(hello.endedSessions).toContainEqual({
          sessionId: 'session-acme-long-0',
          status: 'failed',
        });
      }),
    ));

  it('keeps dialling after a failure of its own while connected', () =>
    run(
      Effect.gen(function* () {
        const cell = yield* fakeCell();
        yield* runnerOf(cell, 20, () => Effect.die(new Error('the runner broke')));
        const first = yield* cell.next;
        yield* first.next;
        first.socket.send(json({ type: 'session.stop', sessionId: 'session-acme-9' }));
        const second = yield* cell.next;
        expect(yield* second.next).toMatchObject({ type: 'hello' });
      }),
    ));

  it('keeps dialling a cell that refuses it, never saying its secret', () =>
    run(
      Effect.gen(function* () {
        const cell = yield* fakeCell({ refuse: 401 });
        const runner = yield* runnerOf(cell, 20);
        // Polled, not a fixed sleep: each dial is a TCP handshake and a 401, slow on a loaded
        // machine.
        yield* Effect.gen(function* () {
          while (cell.attempts() < 3) yield* Effect.sleep(Duration.millis(20));
        }).pipe(
          Effect.timeoutOrElse({
            duration: WAIT,
            orElse: () => Effect.die(new Error(`only ${cell.attempts()} dials in time`)),
          }),
        );
        expect(cell.attempts()).toBeGreaterThanOrEqual(3);
        expect(runner.logged.some((line) => line.includes('401'))).toBe(true);
        expect(runner.logged.join('\n')).not.toContain(SECRET);
      }),
    ));

  it('dials again after the cell closes a frame too large to read', () =>
    run(
      Effect.gen(function* () {
        const cell = yield* fakeCell();
        yield* runnerOf(cell);
        const first = yield* cell.next;
        yield* first.next;
        first.socket.send('x'.repeat(CELL_FRAME_LIMIT_BYTES + 1));
        expect(yield* first.closed).toBe(1009);
        const second = yield* cell.next;
        expect(yield* second.next).toMatchObject({ type: 'hello' });
      }),
    ));

  it('stops dialling once another socket of the runner replaced it (4000)', () =>
    run(
      Effect.gen(function* () {
        const cell = yield* fakeCell();
        const runner = yield* runnerOf(cell, 20);
        const connection = yield* cell.next;
        yield* connection.next;
        connection.socket.close(4000, 'another socket of the runner said hello');
        yield* runner.socket.replaced.pipe(
          Effect.timeoutOrElse({
            duration: WAIT,
            orElse: () => Effect.die(new Error('not told it was replaced')),
          }),
        );
        yield* Effect.sleep(Duration.millis(300));
        expect(cell.attempts()).toBe(1);
      }),
    ));

  it('closes its socket with 1001 when the runner stops, and dials no more', () =>
    run(
      Effect.gen(function* () {
        const cell = yield* fakeCell();
        const runner = yield* runnerOf(cell, 20);
        const connection = yield* cell.next;
        yield* connection.next;
        yield* runner.socket.send(running('session-acme-8'));
        yield* runner.socket.close;
        expect(yield* connection.next).toEqual(running('session-acme-8'));
        expect(yield* connection.closed).toBe(1001);
        yield* Effect.sleep(Duration.millis(200));
        expect(cell.attempts()).toBe(1);
      }),
    ));
});
