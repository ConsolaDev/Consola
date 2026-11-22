import {
  CommandId,
  type OrchestrationV2Command,
  type RuntimeMode,
  ThreadId,
} from '@t3tools/contracts';
import type { OrchestratorV2ScenarioResult } from '@t3tools/server-orchestration/testing';
import * as Clock from 'effect/Clock';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import type * as Scope from 'effect/Scope';
import * as Stream from 'effect/Stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import type { SessionSpec } from '../core/sessionSpec.ts';
import { FAKE_CLIS, isolateMachine } from '../testing/machine.ts';
import {
  loadReplay,
  REPLAY_TIMEOUT_MS,
  REPLAY_TITLE,
  replayClaudeDriver,
  sendMessage,
  sessionSpec,
  statuses,
  TITLE_WITH_CLAUDE,
  waitForSnapshot,
  withState,
} from '../testing/replay.ts';
import * as ThreadRuntime from './threadRuntime.ts';

/**
 * Each test runs on a machine of its own, set on this process's environment: a temporary home, no
 * CLI config or login variables, and fake `claude`, `codex`, `opencode` and `pi` first on the
 * PATH, which record each call and fail; every recorded call must have seen the test's home
 * (`../testing/machine.ts`). Outside a test, the process has a home and fake CLIs of its own,
 * and any CLI run on those fails the file (`../testing/setup.ts`).
 */
const machine = isolateMachine();

/**
 * Every request the code under test makes through `fetch` (t3's HTTP client uses it). A test
 * fails when one was made: these tests run offline.
 */
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
  const made = fetched.splice(0);
  expect(made).toEqual([]);
});

type Replay = {
  readonly spec: SessionSpec;
  readonly handle: ThreadRuntime.ThreadHandle;
  /** The fixture's first message, as t3's scenario sends it. */
  readonly prompt: OrchestrationV2Command;
  /** t3's own checks of this replay, from the fixture's `claude_output.ts`. */
  readonly assertT3Output: Effect.Effect<void, ThreadRuntime.ThreadRuntimeError>;
};

/**
 * Opens a session on t3's production orchestration whose Claude driver replays the recorded
 * Claude variant of one of t3's fixtures, in a git workspace of its own, and runs `body` on it.
 *
 * `runtimeMode` is for a fixture recorded in another mode than the host's `approval-required`;
 * t3's recorded first frame (the Agent SDK options) must match, or the replay refuses it.
 */
const withReplay = <A, E>(
  name: string,
  runtimeMode: RuntimeMode | undefined,
  body: (replay: Replay) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const { variant, transcript, text, cwd } = yield* loadReplay(name);
    return yield* withState(
      (stateDir) =>
        Effect.gen(function* () {
          const spec = sessionSpec(name, cwd, variant.modelSelection);
          const handle = yield* (yield* ThreadRuntime.ThreadRuntime).open(spec);
          const assertT3Output = scenarioResult(handle).pipe(
            Effect.map((result) => variant.assertOutput(result, transcript)),
          );
          const prompt = sendMessage(spec, text, variant.modelSelection);
          return yield* body({ spec, handle, prompt, assertT3Output });
        }).pipe(
          Effect.scoped,
          Effect.provide(
            ThreadRuntime.layerForTests(
              { stateDir },
              {
                drivers: [replayClaudeDriver(transcript)],
                ...(runtimeMode === undefined ? {} : { runtimeMode }),
              },
            ),
          ),
        ),
      TITLE_WITH_CLAUDE,
    );
  }).pipe(Effect.scoped, Effect.runPromise);

/**
 * What t3's scenario runner hands a fixture's `assertOutput`, read from the handle: the thread's
 * stored events in sequence and its projection. The host serves one thread and no thread list,
 * so its shell snapshot lists none.
 *
 * t3's scenario stores nothing before its thread, so it checks the sequences run 1, 2, 3, …; a
 * host files its project first, so the thread's events start one later. They are numbered from
 * 1 here, after checking they have no gap.
 */
const scenarioResult = Effect.fn('scenarioResult')(function* (
  handle: ThreadRuntime.ThreadHandle,
): Effect.fn.Return<OrchestratorV2ScenarioResult, ThreadRuntime.ThreadRuntimeError> {
  const through = handle.snapshotSequence();
  const projection = handle.snapshot();
  const stored = Array.from(
    yield* handle.events().pipe(
      Stream.takeUntil((event) => event.sequence >= through),
      Stream.runCollect,
    ),
  );
  const first = stored[0]?.sequence ?? 1;
  expect(stored.map((event) => event.sequence)).toEqual(stored.map((_, index) => first + index));
  const storedEvents = stored.map((event, index) => ({ ...event, sequence: index + 1 }));
  return {
    storedEvents,
    domainEvents: storedEvents.map((stored) => stored.event),
    projections: new Map([[projection.thread.id, projection]]),
    shellSnapshot: {
      schemaVersion: 1,
      snapshotSequence: through,
      threads: [],
      archivedThreads: [],
    },
    capturedShellSnapshots: new Map(),
  };
});

describe('ThreadRuntime', () => {
  it(
    'opens a thread in approval-required mode, with the session id as its id',
    () =>
      withState((stateDir) =>
        Effect.gen(function* () {
          const spec = sessionSpec('defaults', stateDir);
          const handle = yield* (yield* ThreadRuntime.ThreadRuntime).open(spec);
          expect(handle.snapshot().thread.id).toBe(spec.sessionId);
          expect(handle.snapshot().thread.runtimeMode).toBe('approval-required');
          expect(ThreadRuntime.HOST_RUNTIME_MODE).toBe('approval-required');
        }).pipe(Effect.scoped, Effect.provide(ThreadRuntime.layer({ stateDir }))),
      ).pipe(Effect.runPromise),
    REPLAY_TIMEOUT_MS,
  );

  // `simple` and `turn_interrupt` were recorded in full access (Claude's `bypassPermissions`);
  // under the host's approval-required mode their first frame would not match the recording.
  it(
    'simple: a message gets one answer, the run completes, and t3 titles the thread',
    () =>
      withReplay('simple', 'full-access', ({ handle, prompt, assertT3Output }) =>
        Effect.gen(function* () {
          const sentAt = yield* Clock.currentTimeMillis;
          const before = handle.snapshotSequence();

          yield* handle.dispatch(prompt);
          const projection = yield* waitForSnapshot(handle, (current) =>
            statuses(current).includes('completed'),
          );

          expect(statuses(projection)).toEqual(['completed']);
          const types = projection.turnItems.map((item) => item.type);
          expect(types.filter((type) => type === 'user_message')).toHaveLength(1);
          expect(types.filter((type) => type === 'assistant_message')).toHaveLength(1);
          const answer = projection.turnItems.find((item) => item.type === 'assistant_message');
          expect(answer?.type === 'assistant_message' && answer.text).toContain(
            'fixture simple ok',
          );
          expect(handle.lastActivityMs()).toBeGreaterThanOrEqual(sentAt);

          // Events after a snapshot's sequence continue it exactly: none missed, none repeated.
          const through = handle.snapshotSequence();
          const after = Array.from(
            yield* handle.events(before).pipe(
              Stream.takeUntil((stored) => stored.sequence >= through),
              Stream.runCollect,
            ),
          ).map((stored) => stored.sequence);
          expect(after).toEqual(
            Array.from({ length: through - before }, (_, index) => before + 1 + index),
          );

          // t3's title generation runs, through the provider's own text generation.
          const titled = yield* waitForSnapshot(
            handle,
            (current) => current.thread.title === REPLAY_TITLE,
          );
          expect(titled.thread.title).toBe(REPLAY_TITLE);
          yield* assertT3Output;
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  it(
    'turn_interrupt: interrupting the run leaves it interrupted',
    () =>
      withReplay('turn_interrupt', 'full-access', ({ spec, handle, prompt, assertT3Output }) =>
        Effect.gen(function* () {
          yield* handle.dispatch(prompt).pipe(Effect.forkScoped);
          // Interrupt once the provider turn runs, as t3's scenario does (`await_run_steerable`).
          const running = yield* waitForSnapshot(handle, (current) =>
            current.providerTurns.some((turn) => turn.status === 'running'),
          );
          const runId = running.runs[0]?.id;
          if (runId === undefined) return yield* Effect.die(new Error('no run'));

          yield* handle.dispatch({
            type: 'run.interrupt',
            commandId: CommandId.make(`command:${spec.sessionId}:interrupt-1`),
            threadId: ThreadId.make(spec.sessionId),
            runId,
          });
          const projection = yield* waitForSnapshot(handle, (current) =>
            statuses(current).includes('interrupted'),
          );

          expect(statuses(projection)).toEqual(['interrupted']);
          yield* assertT3Output;
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  // Review Focus 3: an approval that arrives while no client is connected.
  //
  // The brief named `tool_call_read_only`, but t3's Claude variant of it asks for nothing: it was
  // recorded under a read-only sandbox that never asks (`READ_ONLY_NEVER_POLICY`), and its
  // `claude_output.ts` asserts zero runtime requests. It cannot be replayed here at all: t3's
  // production runtime policy (`RuntimePolicy.layerFromProjectStore`) takes a thread's mode and
  // folder, never a sandbox, so its first frame would not match. `tool_call_denied_write` is the
  // Claude fixture recorded in the host's own mode (an approval policy that asks, a writable
  // workspace): one file-change request, declined, and the turn completes.
  it(
    'tool_call_denied_write: an approval waits in the snapshot with no subscriber, then resolves',
    () =>
      withReplay('tool_call_denied_write', undefined, ({ spec, handle, prompt, assertT3Output }) =>
        Effect.gen(function* () {
          expect(handle.snapshot().thread.runtimeMode).toBe('approval-required');
          yield* handle.dispatch(prompt).pipe(Effect.forkScoped);
          // Nothing reads `events` here: the request reaches the snapshot by itself.
          const waiting = yield* waitForSnapshot(handle, (current) =>
            current.runtimeRequests.some((request) => request.status === 'pending'),
          );
          const request = waiting.runtimeRequests.find(
            (candidate) => candidate.status === 'pending',
          );
          if (request === undefined) return yield* Effect.die(new Error('no request'));
          expect(statuses(waiting)).not.toContain('completed');

          // Still pending a while later: only the person answers it.
          yield* Effect.sleep(Duration.millis(200));
          const later = handle.snapshot();
          expect(
            later.runtimeRequests.find((candidate) => candidate.id === request.id)?.status,
          ).toBe('pending');
          expect(statuses(later)).not.toContain('completed');

          yield* handle.dispatch({
            type: 'runtime-request.respond',
            commandId: CommandId.make(`command:${spec.sessionId}:respond-1`),
            threadId: ThreadId.make(spec.sessionId),
            requestId: request.id,
            decision: 'decline',
          });
          const projection = yield* waitForSnapshot(handle, (current) =>
            statuses(current).includes('completed'),
          );

          expect(projection.runtimeRequests.map((candidate) => candidate.status)).toEqual([
            'resolved',
          ]);
          expect(statuses(projection)).toEqual(['completed']);
          yield* assertT3Output;
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  describe('with the person’s CLI (HOST_DRIVERS)', () => {
    /** Runs `body` on a session over t3's real drivers, with `settings` in t3's settings file. */
    const withHostSession = <A, E>(
      settings: Record<string, unknown>,
      body: (session: {
        spec: SessionSpec;
        handle: ThreadRuntime.ThreadHandle;
      }) => Effect.Effect<A, E, Scope.Scope>,
    ) => {
      return withState(
        (stateDir) =>
          Effect.gen(function* () {
            const spec = sessionSpec('host', stateDir);
            const handle = yield* (yield* ThreadRuntime.ThreadRuntime).open(spec);
            return yield* body({ spec, handle });
          }).pipe(Effect.scoped, Effect.provide(ThreadRuntime.layer({ stateDir }))),
        settings,
      ).pipe(Effect.runPromise);
    };

    it(
      'probes only the machine’s fake CLIs, with the test’s home',
      () =>
        withHostSession(
          // t3 leaves OpenCode and Pi off until enabled; on here, so all four drivers probe.
          {
            providerInstances: {
              opencode: { driver: 'opencode', enabled: true },
              pi: { driver: 'pi', enabled: true },
            },
          },
          () =>
            Effect.gen(function* () {
              // Hydration probes every enabled CLI; on this machine each is a fake that records it.
              const probed = () => new Set(machine.calls().map((call) => call.cli));
              yield* Effect.gen(function* () {
                while (!FAKE_CLIS.every((cli) => probed().has(cli))) {
                  yield* Effect.sleep(Duration.millis(20));
                }
              }).pipe(Effect.timeout(Duration.seconds(20)), Effect.orDie);
              const calls = machine.calls();
              expect([...probed()].sort()).toEqual([...FAKE_CLIS].sort());
              for (const call of calls) {
                expect(call).toMatchObject({
                  home: machine.home(),
                  claudeConfigDir: '',
                  codexHome: '',
                });
              }
            }),
        ),
      REPLAY_TIMEOUT_MS,
    );

    it(
      'refuses thread.fork with NotOfferedError, before the orchestrator sees it',
      () =>
        withHostSession({}, ({ spec, handle }) =>
          Effect.gen(function* () {
            const before = handle.snapshotSequence();
            const exit = yield* handle
              .dispatch({
                type: 'thread.fork',
                createdBy: 'user',
                creationSource: 'web',
                commandId: CommandId.make(`command:${spec.sessionId}:fork-1`),
                sourceThreadId: ThreadId.make(spec.sessionId),
                targetThreadId: ThreadId.make(`${spec.sessionId}-fork`),
                sourcePoint: { type: 'latest_stable' },
              })
              .pipe(Effect.exit);

            const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
            expect(Option.getOrUndefined(error)).toBeInstanceOf(ThreadRuntime.NotOfferedError);
            expect(Option.getOrUndefined(error)).toMatchObject({ commandType: 'thread.fork' });
            expect(handle.snapshotSequence()).toBe(before);
          }),
        ),
      REPLAY_TIMEOUT_MS,
    );

    // Review Focus 1: a missing CLI ends in the thread as a failure, never as a spinner.
    it.each([
      [
        'a binary path that does not exist',
        {
          providerInstances: {
            claudeAgent: {
              driver: 'claudeAgent',
              config: { binaryPath: '/nonexistent/sprocket/bin/claude' },
            },
          },
        },
        false,
      ],
      ['no claude on the PATH', {}, true],
    ] as const)(
      'missing CLI (%s): the run fails with an error item within 5 s',
      (_case, settings, noClaudeOnPath) => {
        if (noClaudeOnPath) machine.withoutCli('claude');
        return withHostSession(settings, ({ spec, handle }) =>
          Effect.gen(function* () {
            const modelSelection = handle.snapshot().thread.modelSelection;
            yield* handle
              .dispatch(sendMessage(spec, 'Say hello to Acme.', modelSelection))
              .pipe(Effect.forkScoped);
            const projection = yield* waitForSnapshot(
              handle,
              (current) =>
                statuses(current).includes('failed') &&
                current.turnItems.some((item) => item.type === 'error'),
              Duration.seconds(5),
            );

            expect(statuses(projection)).toEqual(['failed']);
            // The adapter's own error for a CLI that never started, not some other failure.
            const error = projection.turnItems.find((item) => item.type === 'error');
            expect(error?.type === 'error' && error.failure.message).toMatch(
              /^Claude Code process exited with code \d+ before it started\./,
            );
            // No `claude` ran at all: neither the fake nor the developer's own.
            expect(machine.calls().filter((call) => call.cli === 'claude')).toEqual([]);
          }),
        );
      },
      REPLAY_TIMEOUT_MS,
    );
  });
});
