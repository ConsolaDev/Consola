// @effect-diagnostics nodeBuiltinImport:off - Each test makes its own pass keys with node:crypto.
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CommandId,
  type ModelSelection,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadStreamItem,
  RunId,
  ThreadId,
  WS_METHODS,
} from '@t3tools/contracts';
import * as Cause from 'effect/Cause';
import * as Clock from 'effect/Clock';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Queue from 'effect/Queue';
import type * as Scope from 'effect/Scope';
import * as Tracer from 'effect/Tracer';
import * as Stream from 'effect/Stream';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import type * as HttpClient from 'effect/http/HttpClient';
import * as UrlParams from 'effect/http/UrlParams';
import * as Redacted from 'effect/Redacted';
import {
  fetchRemoteSessionState,
  issueRemoteWebSocketTicket,
  resolveRemoteWebSocketConnectionUrl,
} from '@t3tools/client-runtime/authorization';
import { fetchRemoteEnvironmentDescriptor } from '@t3tools/client-runtime/environment';
import { PASS_AUDIENCE, PASS_MAX_LIFETIME_SECONDS, PASS_TYPE } from '@consola/runner-protocol';
import { decodeJwt, SignJWT } from 'jose';
import { userFacingDispatchErrorMessage } from 't3/orchestration-v2/UserFacingErrors.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import type { SessionSpec } from '../core/sessionSpec.ts';
import type { ThreadHandle } from '../runtime/threadRuntime.ts';
import * as ThreadRuntime from '../runtime/threadRuntime.ts';
import { isolateMachine } from '../testing/machine.ts';
import {
  loadReplay,
  REPLAY_TIMEOUT_MS,
  replayClaudeDriver,
  sendMessage,
  sessionSpec,
  statuses,
  waitForSnapshot,
  withState,
} from '../testing/replay.ts';
import { signCellPass } from '../testing/cellPass.ts';
import {
  askHostTicket,
  connectHost,
  connectT3Client,
  hostSocketUrl,
  issueHostTicket,
  type T3Client,
} from '../testing/t3Client.ts';
import { SOCKET_FRAME_PARTS_QUERY_PARAM } from '@t3tools/shared/socketFrameParts';
import { HOST_SCOPES } from './hostHttp.ts';
import { PassKeyInvalid } from './passVerifier.ts';
import { TICKET_LIFETIME_MS } from './socketTickets.ts';
import {
  HOST_REDACTED_URL_PARAMS,
  listenHost,
  NOT_OFFERED_BY_HOST,
  SERVED_METHODS,
  GENERIC_SERVER_VERSION,
  hostEnvironment,
  T3_SERVER_VERSION,
} from './rpcServer.ts';

/** Every test runs on a machine of its own, with fake CLIs (`../testing/machine.ts`). */
isolateMachine();

/** These tests run offline: any request through `fetch` fails the test. */
/**
 * The real `fetch`, read as the module loads (before the stub below), for the tests that call
 * the host as t3's client does: it reaches the host on loopback and nothing else.
 */
const loopbackFetch = (
  (realFetch: typeof globalThis.fetch) => (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname !== '127.0.0.1') {
      return Promise.reject(new Error(`Only the host on loopback: ${url.href}`));
    }
    return realFetch(input, init);
  }
)(globalThis.fetch);

const fetched: string[] = [];
beforeAll(() => {
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return Promise.reject(new Error('These tests make no network request.'));
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  expect(fetched.splice(0)).toEqual([]);
});

/** An Ed25519 key pair made for the test, standing in for the cell's; no key is committed. */
type Keys = { readonly publicKeyPem: string; readonly privateKey: KeyObject };
const makeKeys = (): Keys => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
};

/** A pass for `sessionId` as the cell signs one, for the protocol's longest (or `lifetimeSeconds`). */
const signPass = (keys: Keys, sessionId: string, lifetimeSeconds?: number) =>
  signCellPass(keys.privateKey, sessionId, lifetimeSeconds);

/**
 * Passes signed by the cell's key that break the protocol's contract one way each: another
 * audience, no `typ`, and a lifetime one second over `PASS_MAX_LIFETIME_SECONDS`.
 */
const offContractPasses = Effect.fn('offContractPasses')(function* (keys: Keys, sessionId: string) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const claims = {
    aud: PASS_AUDIENCE,
    sub: 'person-acme-1',
    ws: 'workspace-sprocket',
    sid: sessionId,
  };
  const sign = (payload: Record<string, unknown>, typ: string | null, lifetime: number) =>
    new SignJWT(payload)
      .setProtectedHeader(typ === null ? { alg: 'EdDSA' } : { alg: 'EdDSA', typ })
      .setIssuedAt(now)
      .setExpirationTime(now + lifetime)
      .sign(keys.privateKey);
  return yield* Effect.promise(() =>
    Promise.all([
      sign({ ...claims, aud: 'consola-cell' }, PASS_TYPE, 60),
      sign(claims, null, 60),
      sign(claims, PASS_TYPE, PASS_MAX_LIFETIME_SECONDS + 1),
    ]),
  );
});

/**
 * A plain WebSocket at `url` that opens: when it opened and how it closed, in epoch milliseconds
 * (read from the clock as each event is seen). Fails if it closes without opening.
 */
const openedSocketAt = Effect.fn('openedSocketAt')(function* (url: string) {
  const socket = new WebSocket(url);
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener('close', resolve));
  const opened = new Promise<boolean>((resolve) => {
    socket.addEventListener('open', () => resolve(true));
    void closed.then(() => resolve(false));
  });
  if (!(yield* Effect.promise(() => opened))) {
    return yield* Effect.die(
      new Error(`closed unopened: ${(yield* Effect.promise(() => closed)).code}`),
    );
  }
  const openedAt = yield* Clock.currentTimeMillis;
  const event = yield* Effect.promise(() => closed);
  const closedAt = yield* Clock.currentTimeMillis;
  return { openedAt, closedAt, code: event.code, reason: event.reason };
});

/** The close code a plain WebSocket at `url` ends with. */
const closeCodeAt = (url: string) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve) => {
        const socket = new WebSocket(url);
        socket.addEventListener('close', (event) => resolve(event.code));
      }),
  );

type ConnectError = Effect.Error<ReturnType<typeof connectT3Client>>;

type Served = {
  readonly spec: SessionSpec;
  readonly handle: ThreadHandle;
  readonly keys: Keys;
  readonly port: number;
  /** The server's count of connected clients. */
  readonly connectedClients: () => number;
  /** The fixture's first message, as t3's chat sends it. */
  readonly prompt: OrchestrationV2Command;
  readonly modelSelection: ModelSelection;
  /** A client of t3's, connected with a valid pass for the session (or `pass`). */
  readonly connect: (pass?: string) => Effect.Effect<T3Client, ConnectError, Scope.Scope>;
  readonly signPass: () => Effect.Effect<string>;
};

/**
 * Opens a session whose Claude driver replays the Claude variant of one of t3's fixtures (as
 * `threadRuntime.test.ts` does), serves it on an ephemeral port with a key pair of the test's
 * own, and runs `body`. `simple` was recorded in full access, so it replays in that mode.
 */
const withServedReplay = <A, E>(
  name: string,
  body: (served: Served) => Effect.Effect<A, E, Scope.Scope>,
  /** A tracer for the server's own work: what it serves runs under it. */
  tracer?: Tracer.Tracer,
) =>
  Effect.gen(function* () {
    const { variant, transcript, text, cwd } = yield* loadReplay(name);
    return yield* withState((stateDir) =>
      Effect.gen(function* () {
        const spec = sessionSpec(name, cwd, variant.modelSelection);
        const handle = yield* (yield* ThreadRuntime.ThreadRuntime).open(spec);
        const keys = makeKeys();
        const listening = listenHost({
          port: 0,
          host: '127.0.0.1',
          sessionId: spec.sessionId,
          publicKeyPem: keys.publicKeyPem,
          runtime: handle,
        });
        const { port, connectedClients } = yield* tracer === undefined
          ? listening
          : listening.pipe(Effect.withTracer(tracer));
        const connect = (given?: string) =>
          (given === undefined ? signPass(keys, spec.sessionId) : Effect.succeed(given)).pipe(
            Effect.flatMap((pass) => connectHost(port, pass)),
          );
        return yield* body({
          spec,
          handle,
          keys,
          port,
          connectedClients,
          prompt: sendMessage(spec, text, variant.modelSelection),
          modelSelection: variant.modelSelection,
          connect,
          signPass: () => signPass(keys, spec.sessionId),
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ThreadRuntime.layerForTests(
            { stateDir },
            { drivers: [replayClaudeDriver(transcript)], runtimeMode: 'full-access' },
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.runPromise);

/** Every span a tracer was asked for, as t3's or Effect's native spans record them. */
const recordingTracer = () => {
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { tracer, spans };
};

/** The spans' names, attributes and events, as one text to search. */
function describeSpans(spans: ReadonlyArray<Tracer.NativeSpan>): string {
  return JSON.stringify(
    spans.map((span) => ({
      name: span.name,
      attributes: [...(span._attributes ?? [])],
      events: span._events ?? [],
    })),
  );
}

type StreamItem = OrchestrationV2ThreadStreamItem;
type EventItem = Extract<StreamItem, { readonly kind: 'event' }>;

/** Subscribes `client` to the session's thread; its items queue up as they arrive. */
const subscribe = Effect.fn('subscribe')(function* (
  { client }: T3Client,
  spec: SessionSpec,
  options: { readonly afterSequence?: number } = {},
) {
  const items = yield* Queue.unbounded<StreamItem>();
  yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
    threadId: ThreadId.make(spec.sessionId),
    ...options,
  }).pipe(
    Stream.runForEach((item) => Queue.offer(items, item)),
    Effect.forkScoped,
  );
  return items;
});

const take = (items: Queue.Queue<StreamItem>) =>
  Queue.take(items).pipe(Effect.timeout(Duration.seconds(30)), Effect.orDie);

/** Takes items until `done` holds for one; returns every item taken, that one included. */
const takeUntil = Effect.fn('takeUntil')(function* (
  items: Queue.Queue<StreamItem>,
  done: (item: StreamItem) => boolean,
) {
  const taken: StreamItem[] = [];
  while (true) {
    const item = yield* take(items);
    taken.push(item);
    if (done(item)) return taken;
  }
});

const isEvent = (item: StreamItem): item is EventItem => item.kind === 'event';

/** The event that carries the `simple` fixture's answer, complete. */
const isAnswer = (item: StreamItem) =>
  isEvent(item) &&
  item.event.type === 'turn-item.updated' &&
  item.event.payload.type === 'assistant_message' &&
  item.event.payload.text.includes('fixture simple ok');

/**
 * An event no subscriber may lose. t3 coalesces only an assistant message or turn item still
 * streaming (`ThreadLiveEventCoalescer.ts`), per subscriber and by timing, so two clients may see
 * different ones of those; every other event reaches each.
 */
const isSettled = (item: EventItem) =>
  !(item.event.type === 'message.updated' && item.event.payload.streaming) &&
  !(item.event.type === 'turn-item.updated' && item.event.payload.status === 'running');

/**
 * Runs the fixture's turn to its end. t3's replay adapter fails a session whose recording was not
 * played through, so a test about something else still runs it (and sees the session work).
 */
const runTheTurn = (handle: ThreadHandle, prompt: OrchestrationV2Command) =>
  handle
    .dispatch(prompt)
    .pipe(
      Effect.andThen(waitForSnapshot(handle, (current) => statuses(current).includes('completed'))),
    );

const userMessages = (handle: ThreadHandle) =>
  handle.snapshot().turnItems.filter((item) => item.type === 'user_message');

it("names the lifted t3 server's version (vendor/t3code/apps/server/package.json)", () => {
  const serverPackage = new URL(
    '../../../../vendor/t3code/apps/server/package.json',
    import.meta.url,
  );
  const { version } = JSON.parse(readFileSync(serverPackage, 'utf8')) as { version: string };
  expect(T3_SERVER_VERSION).toBe(version);
});

describe('serveHost', () => {
  it('fails to start, naming the problem and never the key, when the pass key is not an Ed25519 key', async () => {
    const ed448 = generateKeyPairSync('ed448')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    for (const publicKeyPem of ['not a pem', ed448]) {
      const error = await listenHost({
        port: 0,
        host: '127.0.0.1',
        sessionId: 'session-sprocket-key',
        publicKeyPem,
        // Never reached: the key is parsed before anything is served.
        runtime: {} as ThreadHandle,
      }).pipe(Effect.flip, Effect.scoped, Effect.runPromise);
      expect(error).toBeInstanceOf(PassKeyInvalid);
      expect(error.message).toBe(
        'The pass public key is not an Ed25519 public key in SPKI PEM form.',
      );
      // The key's own text (a PEM's base64 line) appears nowhere in the error.
      expect(JSON.stringify(error)).not.toContain(publicKeyPem.split('\n')[1] ?? publicKeyPem);
    }
  });

  it.each(['0.0.0.0', '::', '10.0.0.5', 'sandbox.sprocket.test'])(
    'names no platform or version in its unauthenticated descriptor when bound to %s',
    (host) => {
      const environment = hostEnvironment({ sessionId: 'session-sprocket-env', host });
      expect(environment.platform).toEqual({ os: 'unknown', arch: 'other' });
      expect(environment.serverVersion).toBe(GENERIC_SERVER_VERSION);
      expect(environment.serverVersion).not.toBe(T3_SERVER_VERSION);
      // What a client needs is still there.
      expect(environment).toMatchObject({
        environmentId: 'session-sprocket-env',
        label: 'Consola host',
        orchestrationProtocolVersion: 2,
      });
    },
  );

  it.each([
    ['a loopback bind', { host: '127.0.0.1' }],
    ['localhost', { host: 'localhost' }],
    ['a dev host', { host: '127.0.0.1', dev: true }],
  ])('names its platform and t3 version on %s', (_name, bind) => {
    const environment = hostEnvironment({ sessionId: 'session-sprocket-env', ...bind });
    expect(environment.serverVersion).toBe(T3_SERVER_VERSION);
    expect(environment.platform.os).toBe(
      process.platform === 'darwin'
        ? 'darwin'
        : process.platform === 'linux'
          ? 'linux'
          : environment.platform.os,
    );
    expect(environment.platform.arch).toBe(
      process.arch === 'arm64' || process.arch === 'x64' ? process.arch : 'other',
    );
  });

  it('refuses to listen as a dev host anywhere but loopback, so its long pass stays on this machine', async () => {
    const exit = await listenHost({
      port: 0,
      host: '0.0.0.0',
      sessionId: 'session-sprocket-dev',
      publicKeyPem: makeKeys().publicKeyPem,
      dev: true,
      // Never reached: the address is checked before anything is served.
      runtime: {} as ThreadHandle,
    }).pipe(Effect.scoped, Effect.runPromiseExit);
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toContain(
      'A --dev host listens only on loopback, not on 0.0.0.0.',
    );
  });

  it(
    'answers a command t3 refuses with t3’s own words, in message and detail, as t3’s server does',
    () =>
      withServedReplay('simple', ({ spec, handle, prompt, connect }) =>
        Effect.gen(function* () {
          const { client } = yield* connect();
          const interruptNothing: OrchestrationV2Command = {
            type: 'run.interrupt',
            commandId: CommandId.make(`command:${spec.sessionId}:interrupt-missing`),
            threadId: ThreadId.make(spec.sessionId),
            runId: RunId.make('run:sprocket:missing'),
          };
          const refusal = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            interruptNothing,
          ).pipe(Effect.flip);
          // What t3's `ws.ts` would say: its helper over the orchestrator's own refusal of the same
          // command (under a command id of its own: t3 remembers a refused id as refused).
          const refusedBy = yield* handle
            .dispatch({
              ...interruptNothing,
              commandId: CommandId.make(`command:${spec.sessionId}:interrupt-missing-2`),
            })
            .pipe(Effect.flip);
          const expected =
            refusedBy._tag === 'ThreadRuntimeError'
              ? userFacingDispatchErrorMessage(refusedBy.cause)
              : undefined;
          expect(expected).toBeDefined();
          expect(expected).toBe('Run run:sprocket:missing is not interruptible.');
          expect(refusal).toMatchObject({
            _tag: 'OrchestrationV2DispatchCommandError',
            commandType: 'run.interrupt',
            message: expected,
            detail: expected,
          });
          yield* runTheTurn(handle, prompt);
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  it(
    'opens the socket with a ticket alone, once: none, a forged one, a used one or a pass closes 4401',
    () =>
      withServedReplay('simple', ({ spec, handle, port, prompt, connect, signPass }) =>
        Effect.gen(function* () {
          const pass = yield* signPass();
          expect(yield* closeCodeAt(hostSocketUrl(port))).toBe(4401);
          expect(yield* closeCodeAt(hostSocketUrl(port, 'a-ticket-nobody-issued'))).toBe(4401);
          // A valid pass is no ticket, in the ticket's place or in a `pass` of its own.
          expect(yield* closeCodeAt(hostSocketUrl(port, pass))).toBe(4401);
          const withPass = new URL(hostSocketUrl(port));
          withPass.searchParams.set('pass', pass);
          expect(yield* closeCodeAt(withPass.toString())).toBe(4401);

          // A ticket is not the pass, and opens one socket once.
          const ticket = yield* issueHostTicket(port, pass);
          expect(ticket).not.toBe(pass);
          expect(ticket).not.toContain(pass.split('.')[1] ?? pass);
          yield* Effect.scoped(connectT3Client(hostSocketUrl(port, ticket)));
          expect(yield* closeCodeAt(hostSocketUrl(port, ticket))).toBe(4401);

          // A pass is served through its ticket, and its config names the session and t3's
          // providers.
          const { initialConfig } = yield* connect();
          expect(initialConfig.environment.environmentId).toBe(spec.sessionId);
          // Its thread snapshots come over the socket, so t3's client asks no HTTP route for one.
          expect(initialConfig.threadSnapshotPagination).toBe(true);
          // The session's provider, and no other (the composition hydrates its driver alone).
          expect(initialConfig.providers.map((provider) => provider.instanceId)).toEqual([
            'claudeAgent',
          ]);
          yield* runTheTurn(handle, prompt);
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  it(
    "issues no ticket for a pass it refuses: another key's, another session's, none",
    () =>
      withServedReplay('simple', ({ spec, handle, keys, port, prompt }) =>
        Effect.gen(function* () {
          const foreign = yield* signPass(makeKeys(), spec.sessionId);
          const otherSession = yield* signPass(keys, 'session-sprocket-other');
          for (const refused of [foreign, otherSession, '']) {
            const answer = yield* askHostTicket(port, refused);
            expect(answer.status).toBe(401);
            expect(answer.body).not.toContain('ticket"');
          }
          yield* runTheTurn(handle, prompt);
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  it(
    'counts the clients it lets in, each until its socket closes, and no refused one',
    () =>
      withServedReplay('simple', ({ handle, port, prompt, connect, connectedClients }) =>
        Effect.gen(function* () {
          expect(connectedClients()).toBe(0);
          expect(yield* closeCodeAt(hostSocketUrl(port))).toBe(4401);
          expect(connectedClients()).toBe(0);

          yield* connect();
          expect(connectedClients()).toBe(1);
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* connect();
              expect(connectedClients()).toBe(2);
            }),
          );
          // The second client's socket closes with its scope; the server sees it go.
          yield* Effect.gen(function* () {
            while (connectedClients() !== 1) yield* Effect.sleep(Duration.millis(10));
          }).pipe(Effect.timeout(Duration.seconds(10)), Effect.orDie);
          yield* runTheTurn(handle, prompt);
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  it(
    'closes a connection it let in with 4401 when its pass expires, framed or not',
    () =>
      withServedReplay('simple', ({ spec, handle, prompt, keys, port, connectedClients }) =>
        Effect.gen(function* () {
          const unframed = (ticket: string) => {
            const url = new URL(hostSocketUrl(port, ticket));
            url.searchParams.delete(SOCKET_FRAME_PARTS_QUERY_PARAM);
            return url.toString();
          };
          const ticketFor = (pass: string) => issueHostTicket(port, pass);
          // Two to three seconds left: the socket opens, is served, and is closed at the exp of
          // the pass its ticket was issued for.
          const [framed, plain] = yield* Effect.all(
            [
              signPass(keys, spec.sessionId, 3).pipe(
                Effect.flatMap(ticketFor),
                Effect.flatMap((ticket) => openedSocketAt(hostSocketUrl(port, ticket))),
              ),
              signPass(keys, spec.sessionId, 3).pipe(
                Effect.flatMap(ticketFor),
                Effect.flatMap((ticket) => openedSocketAt(unframed(ticket))),
              ),
            ],
            { concurrency: 'unbounded' },
          );
          for (const closed of [framed, plain]) {
            expect(closed).toMatchObject({ code: 4401, reason: 'The session pass has expired.' });
            // Not refused at the door: open for a while, closed no later than the pass's exp.
            expect(closed.closedAt - closed.openedAt).toBeGreaterThan(500);
            expect(closed.closedAt - closed.openedAt).toBeLessThan(6_000);
          }
          yield* Effect.gen(function* () {
            while (connectedClients() !== 0) yield* Effect.sleep(Duration.millis(10));
          }).pipe(Effect.timeout(Duration.seconds(10)), Effect.orDie);
          yield* runTheTurn(handle, prompt);
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  it('redacts a pass and the ticket wherever Effect shows a URL it serves, as well as its own list', () => {
    const url =
      'ws://127.0.0.1:7420/ws?protocol=2&pass=eyJ.sprocket.sig&wsTicket=t-sprocket&Signature=s3';
    expect(UrlParams.redactUrl(url, HOST_REDACTED_URL_PARAMS)).toBe(
      'ws://127.0.0.1:7420/ws?protocol=2&pass=REDACTED&wsTicket=REDACTED&Signature=REDACTED',
    );
    expect(HOST_REDACTED_URL_PARAMS).toEqual(
      expect.arrayContaining([
        ...UrlParams.CurrentRedactedNames.defaultValue(),
        'pass',
        'wsTicket',
      ]),
    );
  });

  it(
    'hands the pass to no tracer: no span the server makes carries it',
    () => {
      const { tracer, spans } = recordingTracer();
      return withServedReplay(
        'simple',
        ({ handle, prompt, connect, signPass }) =>
          Effect.gen(function* () {
            const pass = yield* signPass();
            const { client } = yield* connect(pass);
            yield* client[WS_METHODS.serverProbe]({});
            yield* runTheTurn(handle, prompt);
            // The tracer was the server's: it saw the server's own work, but no HTTP request
            // span, which would record the request's URL, and the pass travels in it.
            const names = spans.map((span) => span.name);
            expect(names).toContain('host.app');
            expect(names).not.toContain('GET');
            const recorded = describeSpans(spans);
            expect(recorded).not.toContain(pass);
            expect(recorded).not.toContain('person-acme-1');
          }),
        tracer,
      );
    },
    REPLAY_TIMEOUT_MS,
  );

  it(
    'subscribeThread yields a snapshot first, then events, then the simple fixture’s answer',
    () =>
      withServedReplay('simple', ({ spec, handle, prompt, connect }) =>
        Effect.gen(function* () {
          const client = yield* connect();
          const items = yield* subscribe(client, spec);
          const first = yield* take(items);
          if (first.kind !== 'snapshot') return yield* Effect.die(new Error(first.kind));
          expect(first.projection.thread.id).toBe(spec.sessionId);
          expect(first.snapshotSequence).toBe(handle.snapshotSequence());

          const { sequence } =
            yield* client.client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](prompt);
          const rest = yield* takeUntil(items, isAnswer);
          expect(rest.every(isEvent)).toBe(true);
          const sequences = rest.filter(isEvent).map((item) => item.sequence);
          expect(sequences[0]).toBeGreaterThan(first.snapshotSequence);
          expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
          expect(new Set(sequences).size).toBe(sequences.length);
          expect(sequence).toBeGreaterThan(first.snapshotSequence);
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  it(
    'a client that subscribes after the turn gets a snapshot that holds the answer, then live events (Review Focus 2)',
    () =>
      withServedReplay('simple', ({ spec, handle, prompt, modelSelection, connect }) =>
        Effect.gen(function* () {
          const before = handle.snapshotSequence();
          yield* handle.dispatch(prompt);
          yield* waitForSnapshot(handle, (current) => statuses(current).includes('completed'));

          const late = yield* connect();
          const items = yield* subscribe(late, spec);
          const first = yield* take(items);
          if (first.kind !== 'snapshot') return yield* Effect.die(new Error(first.kind));
          const answers = first.projection.turnItems.filter(
            (item) => item.type === 'assistant_message',
          );
          expect(answers.map((item) => item.type === 'assistant_message' && item.text)).toEqual([
            expect.stringContaining('fixture simple ok'),
          ]);

          // Then live: a later command's events follow the snapshot, none of them repeated.
          yield* late.client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: 'thread.model-selection.set',
            commandId: CommandId.make(`command:${spec.sessionId}:model-1`),
            threadId: ThreadId.make(spec.sessionId),
            modelSelection,
          });
          const live = yield* takeUntil(
            items,
            (item) => isEvent(item) && item.event.type === 'thread.model-selection-updated',
          );
          for (const item of live) {
            expect(isEvent(item) && item.sequence).toBeGreaterThan(first.snapshotSequence);
          }

          // A client resuming from a sequence it saw is sent what followed it, as t3 replays it.
          const resumed = yield* subscribe(yield* connect(), spec, { afterSequence: before });
          const replay = yield* takeUntil(resumed, isAnswer);
          expect(replay.every(isEvent)).toBe(true);
          expect(replay.filter(isEvent)[0]?.sequence).toBe(before + 1);
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  it(
    'two clients see the same events, and a command one sends is applied once (Review Focus 4)',
    () =>
      withServedReplay('simple', ({ spec, handle, prompt, connect }) =>
        Effect.gen(function* () {
          const clientA = yield* connect();
          const clientB = yield* connect();
          const itemsA = yield* subscribe(clientA, spec);
          const itemsB = yield* subscribe(clientB, spec);
          expect((yield* take(itemsA)).kind).toBe('snapshot');
          expect((yield* take(itemsB)).kind).toBe('snapshot');
          expect(userMessages(handle)).toHaveLength(0);

          yield* clientA.client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](prompt);
          yield* waitForSnapshot(handle, (current) => statuses(current).includes('completed'));
          // The same command again (a retry of A's) is t3's replay of it, not a second message.
          yield* clientB.client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](prompt);
          const through = handle.snapshotSequence();

          const reached = (item: StreamItem) => isEvent(item) && item.sequence >= through;
          const seenA = (yield* takeUntil(itemsA, reached)).filter(isEvent);
          const seenB = (yield* takeUntil(itemsB, reached)).filter(isEvent);
          expect(seenA.some(isAnswer)).toBe(true);
          expect(seenB.some(isAnswer)).toBe(true);
          const settled = (seen: EventItem[]) =>
            seen.filter(isSettled).map((item) => [item.sequence, item.event.type]);
          expect(settled(seenB)).toEqual(settled(seenA));
          expect(userMessages(handle)).toHaveLength(1);
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  it(
    'answers a method it does not serve with NotOfferedByHost: orchestration.getTurnDiff, subscribeShell',
    () =>
      withServedReplay('simple', ({ spec, handle, prompt, connect }) =>
        Effect.gen(function* () {
          expect(SERVED_METHODS).not.toContain(ORCHESTRATION_V2_WS_METHODS.getTurnDiff);
          const { client } = yield* connect();
          const notOffered = (exit: Exit.Exit<unknown, unknown>, method: string) => {
            expect(Exit.isFailure(exit)).toBe(true);
            const defects = Exit.isFailure(exit)
              ? exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)
              : [];
            expect(defects).toEqual([
              expect.objectContaining({
                name: NOT_OFFERED_BY_HOST,
                message: `This host does not offer ${method}.`,
              }),
            ]);
          };
          const diff = yield* client[ORCHESTRATION_V2_WS_METHODS.getTurnDiff]({
            threadId: ThreadId.make(spec.sessionId),
            fromTurnCount: 0,
            toTurnCount: 1,
          }).pipe(Effect.exit);
          notOffered(diff, ORCHESTRATION_V2_WS_METHODS.getTurnDiff);
          const shell = yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
            Stream.runDrain,
            Effect.exit,
          );
          notOffered(shell, ORCHESTRATION_V2_WS_METHODS.subscribeShell);
          // The connection still serves after a refused call.
          expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
          yield* runTheTurn(handle, prompt);
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );
});

describe("before the socket: what t3's client-runtime asks over HTTP", () => {
  /** t3's own calls (`@t3tools/client-runtime`), over an HTTP client that reaches loopback only. */
  const asT3Client = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, loopbackFetch as typeof globalThis.fetch),
    );

  it(
    'answers the descriptor, a ticket that is not the pass, and the session it opens; the ticket opens the socket once',
    () =>
      withServedReplay('simple', ({ spec, handle, prompt, port, signPass: passForSession }) =>
        Effect.gen(function* () {
          const httpBaseUrl = `http://127.0.0.1:${port}`;
          const pass = yield* passForSession();
          const expiresAtMs = (decodeJwt(pass).exp ?? 0) * 1000;

          const descriptor = yield* asT3Client(fetchRemoteEnvironmentDescriptor({ httpBaseUrl }));
          expect(descriptor).toMatchObject({
            environmentId: spec.sessionId,
            label: 'Consola host',
            orchestrationProtocolVersion: 2,
          });

          const askedAt = yield* Clock.currentTimeMillis;
          const ticket = yield* asT3Client(
            issueRemoteWebSocketTicket({ httpBaseUrl, bearerToken: pass, use: 'rpc' }),
          );
          // Random, short-lived, and never the pass, which travels in the header alone.
          expect(Redacted.value(ticket.ticket)).not.toBe(pass);
          expect(Redacted.value(ticket.ticket)).toMatch(/^[A-Za-z0-9_-]{43}$/);
          expect(ticket.expiresAt.epochMilliseconds).toBeLessThanOrEqual(
            Math.min(expiresAtMs, (yield* Clock.currentTimeMillis) + TICKET_LIFETIME_MS),
          );
          expect(ticket.expiresAt.epochMilliseconds).toBeGreaterThan(askedAt);

          const session = yield* asT3Client(
            fetchRemoteSessionState({ httpBaseUrl, bearerToken: pass }),
          );
          expect(session).toMatchObject({
            authenticated: true,
            permissions: [...HOST_SCOPES],
            sessionMethod: 'bearer-access-token',
            auth: { sessionMethods: ['bearer-access-token'] },
          });
          expect(session.expiresAt?.epochMilliseconds).toBe(expiresAtMs);

          // The socket URL t3's client builds from the ticket (`wsTicket`), with the protocol and
          // frame-parts flags its resolver and session add.
          const socketUrl = new URL(
            yield* asT3Client(
              resolveRemoteWebSocketConnectionUrl({
                httpBaseUrl,
                wsBaseUrl: `ws://127.0.0.1:${port}`,
                bearerToken: pass,
              }),
            ),
          );
          const socketTicket = socketUrl.searchParams.get('wsTicket') ?? '';
          expect(socketTicket).not.toBe(pass);
          expect(socketTicket).not.toBe(Redacted.value(ticket.ticket));
          expect(socketUrl.toString()).not.toContain(pass);
          const withFlags = new URL(hostSocketUrl(port));
          for (const [name, value] of socketUrl.searchParams)
            withFlags.searchParams.set(name, value);
          const { initialConfig } = yield* connectT3Client(withFlags.toString());
          expect(initialConfig.environment.environmentId).toBe(spec.sessionId);
          // Used once: the same URL opens nothing again.
          expect(yield* closeCodeAt(withFlags.toString())).toBe(4401);
          yield* runTheTurn(handle, prompt);
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  it(
    'refuses a pass as t3 refuses a bearer token (401, invalid) and reads no session from it',
    () =>
      withServedReplay('simple', ({ spec, handle, prompt, keys, port }) =>
        Effect.gen(function* () {
          const httpBaseUrl = `http://127.0.0.1:${port}`;
          const ticketFor = (bearerToken: string) =>
            asT3Client(issueRemoteWebSocketTicket({ httpBaseUrl, bearerToken, use: 'rpc' })).pipe(
              Effect.flip,
            );
          expect(yield* ticketFor('')).toMatchObject({
            _tag: 'EnvironmentAuthInvalidError',
            reason: 'missing_credential',
          });
          expect(yield* ticketFor('not-a-pass')).toMatchObject({
            _tag: 'EnvironmentAuthInvalidError',
            reason: 'invalid_credential',
          });
          // Signed by the cell's key, for another session: t3 has no other answer for a token.
          const anotherSessions = yield* signPass(keys, 'session-sprocket-another');
          expect(yield* ticketFor(anotherSessions)).toMatchObject({
            _tag: 'EnvironmentAuthInvalidError',
            reason: 'invalid_credential',
          });
          // A pass is the protocol's alone: another audience, no type, or a lifetime over the cap
          // is no pass, whatever key signed it.
          for (const offContract of yield* offContractPasses(keys, spec.sessionId)) {
            expect(yield* ticketFor(offContract)).toMatchObject({
              _tag: 'EnvironmentAuthInvalidError',
              reason: 'invalid_credential',
            });
          }
          for (const refused of ['not-a-pass', anotherSessions]) {
            const session = yield* asT3Client(
              fetchRemoteSessionState({ httpBaseUrl, bearerToken: refused }),
            );
            expect(session).toEqual({
              authenticated: false,
              auth: expect.objectContaining({ sessionMethods: ['bearer-access-token'] }),
            });
          }
          yield* runTheTurn(handle, prompt);
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  it(
    "answers a browser on another origin with t3's CORS headers, a 404 included, before any pass",
    () =>
      withServedReplay('simple', ({ handle, prompt, port }) =>
        Effect.promise(async () => {
          const origin = 'http://localhost:5733';
          const preflight = await loopbackFetch(
            `http://127.0.0.1:${port}/api/auth/websocket-ticket/rpc`,
            {
              method: 'OPTIONS',
              headers: {
                origin,
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'authorization',
              },
            },
          );
          expect(preflight.status).toBeLessThan(300);
          expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
          expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
          const elsewhere = await loopbackFetch(
            `http://127.0.0.1:${port}/api/orchestration/shell`,
            {
              headers: { origin },
            },
          );
          expect(elsewhere.status).toBe(404);
          expect(elsewhere.headers.get('access-control-allow-origin')).toBe('*');
        }).pipe(Effect.andThen(runTheTurn(handle, prompt))),
      ),
    REPLAY_TIMEOUT_MS,
  );
});
