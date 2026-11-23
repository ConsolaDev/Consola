/**
 * The runner's socket to its cell (`apps/cloud-region`, "The runner's socket"): it dials out,
 * so the cell never has to reach the runner. Its secret travels in the upgrade's `Authorization`
 * header, which `ws` can send and Node's own WebSocket cannot portably. The messages are
 * `@consola/runner-protocol`'s.
 *
 * - Every connection opens with `hello`: the offer, the sessions the runner still holds, and the
 *   ends the cell may not have heard (`EndedSessions`). Then each live session's state goes again
 *   (its address and title), since updates on a socket the cell replaced can be lost.
 * - An update while the socket is down is not queued: the state after the next `hello` says it.
 *   An end is held for that `hello` instead.
 * - A socket that drops is dialled again after a jittered wait that doubles to 30 s
 *   (`reconnectDelayMs`), and starts over once a connection has held. A close with 4000 means
 *   another process with this runner's secret said hello: this one stops dialling, so two runners
 *   sharing a secret never take the socket from each other in a loop (`replaced`).
 * - A frame from the cell over `CELL_FRAME_LIMIT_BYTES` closes the socket (1009); one that is not
 *   a message `readCellMessage` reads is logged with the reader's reason and dropped.
 */
import {
  type CellMessage,
  type RunnerHello,
  readCellMessage,
  type SessionUpdate,
} from '@consola/runner-protocol';
import * as Clock from 'effect/Clock';
import * as Deferred from 'effect/Deferred';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Queue from 'effect/Queue';
import * as Random from 'effect/Random';
import { type RawData, WebSocket } from 'ws';
import {
  EndedSessions,
  endOf,
  type RunnerOffer,
  reconnectDelayMs,
} from '../core/runnerDecisions.ts';
import type { LiveSessions } from './sandboxSessions.ts';

/** The cell's frame limit (`RUNNER_FRAME_LIMIT_BYTES`), which the runner keeps for what it reads too. */
export const CELL_FRAME_LIMIT_BYTES = 64 * 1024;

/** The cell's close for a socket another socket of the same runner replaced. */
export const REPLACED_CLOSE_CODE = 4000;

/** How long a connection must stay open to count as holding, so the next wait starts over. */
const HOLDS_AFTER = Duration.seconds(10);

/** How long the upgrade may take before the attempt counts as failed. */
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** How long closing waits for the cell to answer the close, so what was sent before it arrives. */
const CLOSE_WAIT = Duration.seconds(3);

export type CellSocketOptions = {
  /** The cell's runner socket (`--cell-url`), checked by `cellUrlProblem` already. */
  readonly url: string;
  readonly secret: string;
  readonly runnerId: string;
  readonly offer: RunnerOffer;
  /** A line for the runner's log. The secret never reaches it. */
  readonly log: (message: string) => Effect.Effect<void>;
  /** The wait before dialling again (`reconnectDelayMs` unless a test shortens it). */
  readonly reconnectDelay?: (failures: number, random: number) => number;
};

/** What the socket asks of the runner's sessions. */
export type CellHandlers = {
  /** What the runner holds right now, read as `hello` is written. */
  readonly live: () => LiveSessions;
  /** A message from the cell, in the order the cell sent them. */
  readonly onMessage: (message: CellMessage) => Effect.Effect<void>;
};

export type CellSocket = {
  /** Says `update` to the cell now, if a `hello` went on the open socket (see above). */
  readonly send: (update: SessionUpdate) => Effect.Effect<void>;
  /** Starts dialling, in the background, until `close` or a replacement. */
  readonly connect: (handlers: CellHandlers) => Effect.Effect<void>;
  /** Done once another socket of this runner replaced this one (close 4000); dialling has stopped. */
  readonly replaced: Effect.Effect<void>;
  /** Stops dialling and closes the socket with 1001, waiting briefly for the cell to answer. */
  readonly close: Effect.Effect<void>;
};

type SocketEvent =
  | { readonly type: 'open' }
  | { readonly type: 'message'; readonly text: string | null }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'close'; readonly code: number; readonly reason: string };

/** How one connection ended. */
type Closed = {
  readonly code: number;
  readonly reason: string;
  readonly opened: boolean;
  readonly heldMs: number;
  readonly error: string | null;
};

type Open = { readonly ws: WebSocket; readonly id: number; helloSent: boolean };

const encode = (message: RunnerHello | SessionUpdate): string => JSON.stringify(message);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const textOf = (data: RawData): string =>
  Array.isArray(data)
    ? Buffer.concat(data).toString('utf8')
    : Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Buffer.from(data).toString('utf8');

export const makeCellSocket = (options: CellSocketOptions): Effect.Effect<CellSocket> =>
  Effect.gen(function* () {
    const ends = new EndedSessions();
    const replacedSignal = yield* Deferred.make<boolean>();
    const stopped = yield* Deferred.make<boolean>();
    const delayOf = options.reconnectDelay ?? reconnectDelayMs;
    /** The socket greeted, once its `hello` went. */
    let current: Open | null = null;
    /** The latest socket, in whatever state: closing ends it. */
    let latest: WebSocket | null = null;
    let connections = 0;
    let closing = false;
    let loop: Fiber.Fiber<void> | null = null;

    const sayHello = Effect.fn('CellSocket.sayHello')(function* (
      open: Open,
      handlers: CellHandlers,
    ) {
      const nowMs = yield* Clock.currentTimeMillis;
      // One synchronous step: nothing a session says can fall between what hello reads and
      // the socket counting as greeted.
      const said = yield* Effect.sync(() => {
        const live = handlers.live();
        const endedSessions = ends.forHello();
        const ended = new Set(endedSessions.map((end) => end.sessionId));
        const hello: RunnerHello = {
          type: 'hello',
          runnerId: options.runnerId,
          repositories: [...options.offer.repositories],
          harnesses: [...options.offer.harnesses],
          runningSessionIds: live.sessionIds.filter((sessionId) => !ended.has(sessionId)),
          endedSessions,
        };
        open.ws.send(encode(hello));
        ends.sent([...ended], open.id, nowMs);
        for (const state of live.states) {
          if (!ended.has(state.sessionId)) open.ws.send(encode(state));
        }
        open.helloSent = true;
        return { running: hello.runningSessionIds.length, ended: endedSessions.length };
      });
      yield* options.log(
        `connected to the cell: ${said.running} sessions running, ${said.ended} ended while away`,
      );
    });

    const onFrame = (text: string | null, handlers: CellHandlers): Effect.Effect<void> => {
      if (text === null) return options.log('a binary frame from the cell, dropped');
      const read = readCellMessage(parseJson(text));
      if (!read.ok)
        return options.log(`a message from the cell it cannot read (${read.reason}), dropped`);
      return handlers.onMessage(read.value);
    };

    /** One connection, from dialling to its close. */
    const connectOnce = (handlers: CellHandlers): Effect.Effect<Closed> =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<SocketEvent>();
        const id = ++connections;
        const ws = yield* Effect.sync(() => {
          const socket = new WebSocket(options.url, {
            headers: { Authorization: `Bearer ${options.secret}` },
            maxPayload: CELL_FRAME_LIMIT_BYTES,
            handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
          });
          socket.on('open', () => Queue.offerUnsafe(events, { type: 'open' }));
          socket.on('message', (data, isBinary) =>
            Queue.offerUnsafe(events, { type: 'message', text: isBinary ? null : textOf(data) }),
          );
          socket.on('error', (error) =>
            Queue.offerUnsafe(events, { type: 'error', message: error.message }),
          );
          socket.on('close', (code, reason) =>
            Queue.offerUnsafe(events, { type: 'close', code, reason: reason.toString('utf8') }),
          );
          latest = socket;
          return socket;
        });
        let openedAt: number | null = null;
        let error: string | null = null;
        while (true) {
          const event = yield* Queue.take(events);
          if (event.type === 'open') {
            openedAt = yield* Clock.currentTimeMillis;
            const open: Open = { ws, id, helloSent: false };
            current = open;
            yield* sayHello(open, handlers);
          } else if (event.type === 'message') {
            yield* onFrame(event.text, handlers);
          } else if (event.type === 'error') {
            error = event.message;
          } else {
            const nowMs = yield* Clock.currentTimeMillis;
            if (current?.id === id) current = null;
            ends.closed(id, nowMs);
            return {
              code: event.code,
              reason: event.reason,
              opened: openedAt !== null,
              heldMs: openedAt === null ? 0 : nowMs - openedAt,
              error,
            };
          }
        }
      });

    const dialling = (handlers: CellHandlers): Effect.Effect<void> =>
      Effect.gen(function* () {
        let failures = 0;
        while (!closing) {
          const closed = yield* connectOnce(handlers);
          if (closing) break;
          if (closed.code === REPLACED_CLOSE_CODE) {
            yield* options.log(
              'another runner with this secret connected to the cell and replaced this one; this one stops dialling',
            );
            yield* Deferred.succeed(replacedSignal, true);
            break;
          }
          failures = closed.heldMs >= Duration.toMillis(HOLDS_AFTER) ? 0 : failures + 1;
          const delayMs = delayOf(failures, yield* Random.next);
          const why = closed.opened
            ? `the cell closed the socket (${closed.code}${closed.reason === '' ? '' : `: ${closed.reason}`})`
            : `cannot reach the cell (${closed.error ?? `closed ${closed.code}`})`;
          yield* options.log(`${why}; dialling again in ${delayMs} ms`);
          yield* Effect.sleep(Duration.millis(delayMs));
        }
      }).pipe(Effect.ensuring(Deferred.succeed(stopped, true)));

    const socket: CellSocket = {
      send: Effect.fn('CellSocket.send')(function* (update: SessionUpdate) {
        const nowMs = yield* Clock.currentTimeMillis;
        const dropped = yield* Effect.sync(() => {
          const end = endOf(update);
          const lost = end === null ? null : ends.add(end);
          const open = current;
          if (open?.helloSent === true && open.ws.readyState === WebSocket.OPEN) {
            open.ws.send(encode(update));
            if (end !== null) ends.sent([update.sessionId], open.id, nowMs);
          }
          return lost;
        });
        if (dropped !== null) {
          yield* options.log(
            `too many ends held for the cell; the end of session ${dropped.sessionId} is dropped`,
          );
        }
      }),
      connect: Effect.fn('CellSocket.connect')(function* (handlers: CellHandlers) {
        if (loop !== null || closing) return;
        loop = yield* dialling(handlers).pipe(Effect.forkDetach);
      }),
      replaced: Deferred.await(replacedSignal).pipe(Effect.asVoid),
      close: Effect.gen(function* () {
        closing = true;
        const ws = latest;
        if (ws !== null && ws.readyState === WebSocket.OPEN && loop !== null) {
          ws.close(1001, 'the runner is stopping');
          yield* Deferred.await(stopped).pipe(
            Effect.timeoutOrElse({ duration: CLOSE_WAIT, orElse: () => Effect.succeed(true) }),
          );
        }
        if (loop !== null) yield* Fiber.interrupt(loop);
        // Still dialling, or the cell did not answer the close: nothing more goes on it.
        if (ws !== null && ws.readyState !== WebSocket.CLOSED) ws.terminate();
        current = null;
      }),
    };
    return socket;
  });
