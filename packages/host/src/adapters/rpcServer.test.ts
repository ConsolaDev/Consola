// @effect-diagnostics nodeBuiltinImport:off - Each test makes its own pass keys with node:crypto.
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
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
import * as UrlParams from 'effect/http/UrlParams';
import { SignJWT } from 'jose';
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
  TITLE_WITH_CLAUDE,
  waitForSnapshot,
  withState,
} from '../testing/replay.ts';
import { connectT3Client, hostSocketUrl, type T3Client } from '../testing/t3Client.ts';
import { PassKeyInvalid } from './passVerifier.ts';
import {
  HOST_REDACTED_URL_PARAMS,
  listenHost,
  NOT_OFFERED_BY_HOST,
  SERVED_METHODS,
} from './rpcServer.ts';

/** Every test runs on a machine of its own, with fake CLIs (`../testing/machine.ts`). */
isolateMachine();

/** These tests run offline: any request through `fetch` fails the test. */
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

/** A pass for `sessionId`, valid for ten minutes, as the cell signs one. */
const signPass = Effect.fn('signPass')(function* (keys: Keys, sessionId: string) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  return yield* Effect.promise(() =>
    new SignJWT({ sub: 'person-acme-1', ws: 'workspace-sprocket', sid: sessionId })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(keys.privateKey),
  );
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
    return yield* withState(
      (stateDir) =>
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
              Effect.flatMap((pass) => connectT3Client(hostSocketUrl(port, pass))),
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
      TITLE_WITH_CLAUDE,
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
    'refuses a connection without a valid pass: none or another key closes 4401, another session 4403',
    () =>
      withServedReplay('simple', ({ spec, handle, keys, port, prompt, connect }) =>
        Effect.gen(function* () {
          expect(yield* closeCodeAt(hostSocketUrl(port))).toBe(4401);
          const foreign = yield* signPass(makeKeys(), spec.sessionId);
          expect(yield* closeCodeAt(hostSocketUrl(port, foreign))).toBe(4401);
          const otherSession = yield* signPass(keys, 'session-sprocket-other');
          expect(yield* closeCodeAt(hostSocketUrl(port, otherSession))).toBe(4403);

          // A valid pass is served, and its config names the session and t3's providers.
          const { initialConfig } = yield* connect();
          expect(initialConfig.environment.environmentId).toBe(spec.sessionId);
          expect(initialConfig.providers.map((provider) => provider.instanceId)).toContain(
            'claudeAgent',
          );
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

  it('redacts the pass wherever Effect shows a URL it serves, as well as its own list', () => {
    const url = 'ws://127.0.0.1:7420/ws?protocol=2&pass=eyJ.sprocket.sig&Signature=s3';
    expect(UrlParams.redactUrl(url, HOST_REDACTED_URL_PARAMS)).toBe(
      'ws://127.0.0.1:7420/ws?protocol=2&pass=REDACTED&Signature=REDACTED',
    );
    expect(HOST_REDACTED_URL_PARAMS).toEqual(
      expect.arrayContaining([...UrlParams.CurrentRedactedNames.defaultValue(), 'pass']),
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
