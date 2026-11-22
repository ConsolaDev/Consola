// @effect-diagnostics nodeBuiltinImport:off - Each session gets temporary folders of its own.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from '@t3tools/contracts';
import { ClaudeOrchestratorReplayHarness } from '@t3tools/provider-claude/testing';
import type { AnyProviderDriver, ProviderInstance } from '@t3tools/provider-core/server/driver';
import { checkpointWorkspace } from '@t3tools/provider-testing/replayWorkspace';
import {
  ORCHESTRATOR_REPLAY_FIXTURES,
  type OrchestratorV2ScenarioResult,
  ProviderReplayFixtures,
} from '@t3tools/server-orchestration/testing';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import type * as Scope from 'effect/Scope';
import * as Stream from 'effect/Stream';
import * as ProviderAdapterRegistry from 't3/orchestration-v2/ProviderAdapterRegistry.ts';
import { materializeReplayTranscriptRuntimeInstructions } from 't3/orchestration-v2/testkit/ReplayRuntimeInstructions.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import type { SessionSpec } from '../core/sessionSpec.ts';
import { FAKE_CLIS, isolateMachine } from '../testing/machine.ts';
import { HOST_DRIVERS, type HostDriversEnv } from './drivers.ts';
import * as ThreadRuntime from './threadRuntime.ts';

/** A replay runs a whole recorded turn through t3's orchestrator; under load that takes a while. */
const REPLAY_TIMEOUT_MS = 60_000;

/** The title the replay's text generation gives every thread. */
const REPLAY_TITLE = 'Sprocket replay title';

/**
 * Each test runs on a machine of its own: a temporary home, no CLI config variables, and fake
 * `claude`, `codex`, `opencode` and `pi` first on the PATH, which record each call and fail; every
 * recorded call must have seen the test's home (`../testing/machine.ts`).
 */
const machine = isolateMachine();

/** t3's settings for a test: no update checks, so nothing asks npm or GitHub. */
const TEST_SETTINGS = { enableProviderUpdateChecks: false };

/**
 * A state folder for one session, removed when `use` ends, with t3's settings file
 * (`<stateDir>/userdata/settings.json`): `TEST_SETTINGS` and `settings`.
 */
const withState = <A, E, R>(
  use: (stateDir: string) => Effect.Effect<A, E, R>,
  settings: Record<string, unknown> = {},
) => {
  const settingsFile = JSON.stringify({ ...TEST_SETTINGS, ...settings });
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const stateDir = mkdtempSync(join(tmpdir(), 'consola-host-state-'));
      mkdirSync(join(stateDir, 'userdata'), { recursive: true });
      writeFileSync(join(stateDir, 'userdata', 'settings.json'), settingsFile);
      return stateDir;
    }),
    use,
    (stateDir) => Effect.sync(() => rmSync(stateDir, { recursive: true, force: true })),
  );
};

/** t3 titles threads with Codex by default; a replay session has only Claude to ask. */
const TITLE_WITH_CLAUDE = {
  textGenerationModelSelection: { instanceId: 'claudeAgent', model: 'claude-haiku-5-5' },
};

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

/** The replay stands in for an installed, signed-in Claude: t3 asks it for thread titles. */
const asInstalled = (provider: ServerProvider): ServerProvider => ({
  ...provider,
  enabled: true,
  installed: true,
  status: 'ready',
  auth: { ...provider.auth, status: 'authenticated' },
});

type ReplayTranscript = Effect.Success<
  ReturnType<typeof ClaudeOrchestratorReplayHarness.decodeTranscript>
>;

/** The host's own Claude driver: t3's, guarded by `withoutCliCredentialsDriver`. */
const hostClaudeDriver = HOST_DRIVERS.find((driver) => driver.driverKind === 'claudeAgent');

/**
 * The host's Claude driver with its orchestration adapter replaced by t3's Claude replay adapter,
 * the way t3's replay harness substitutes it, and a fixed thread title in place of the CLI's. The
 * `claude` on the PATH is the machine's fake, so its snapshot is made to read as installed.
 */
const replayClaudeDriver = (transcript: ReplayTranscript): AnyProviderDriver<HostDriversEnv> => {
  if (hostClaudeDriver === undefined) throw new Error('HOST_DRIVERS has no Claude driver.');
  return {
    ...hostClaudeDriver,
    create: (input) => replayInstance(hostClaudeDriver.create(input), transcript),
  };
};

const replayInstance = Effect.fn('replayInstance')(function* <E, R>(
  created: Effect.Effect<ProviderInstance, E, R>,
  transcript: ReplayTranscript,
) {
  const instance = yield* created;
  const replay = yield* Layer.build(
    ClaudeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript),
  ).pipe(Effect.orDie);
  const adapter = yield* Context.get(replay, ProviderAdapterRegistry.ProviderAdapterRegistryV2)
    .get(instance.instanceId)
    .pipe(Effect.orDie);
  return {
    ...instance,
    snapshot: {
      ...instance.snapshot,
      getSnapshot: instance.snapshot.getSnapshot.pipe(Effect.map(asInstalled)),
      refresh: instance.snapshot.refresh.pipe(Effect.map(asInstalled)),
      streamChanges: instance.snapshot.streamChanges.pipe(Stream.map(asInstalled)),
    },
    orchestrationAdapter: adapter,
    textGeneration: {
      ...instance.textGeneration,
      generateThreadTitle: () => Effect.succeed({ title: REPLAY_TITLE }),
    },
  };
});

const sessionSpec = (name: string, cwd: string, modelSelection?: ModelSelection): SessionSpec => ({
  sessionId: `session-sprocket-${name}`,
  harness: 'claude',
  cwd,
  ...(modelSelection === undefined ? {} : { modelSelection }),
});

/** A thread's first message, as t3's chat sends it: its text seeds the thread's title. */
const sendMessage = (
  spec: SessionSpec,
  text: string,
  modelSelection: ModelSelection,
): OrchestrationV2Command => ({
  type: 'message.dispatch',
  createdBy: 'user',
  creationSource: 'web',
  commandId: CommandId.make(`command:${spec.sessionId}:message-1`),
  threadId: ThreadId.make(spec.sessionId),
  messageId: MessageId.make(`message:${spec.sessionId}:1`),
  text,
  titleSeed: text,
  attachments: [],
  modelSelection,
  dispatchMode: { type: 'start_immediately' },
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
    const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((candidate) => candidate.name === name);
    const variant = fixture?.providers.find((provider) => provider.driver === 'claudeAgent');
    const input = fixture?.buildInput();
    const message = input?.steps.find((step) => step.type === 'message');
    if (variant === undefined || message?.type !== 'message') {
      return yield* Effect.die(new Error(`t3 has no Claude replay of ${name}`));
    }
    const recorded = yield* ProviderReplayFixtures.readReplayFixtureTranscript(
      variant.transcriptFile,
    );
    const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
      materializeReplayTranscriptRuntimeInstructions(recorded, {
        driver: variant.driver,
        model: variant.modelSelection.model,
      }),
    );
    const cwd = yield* checkpointWorkspace(name, input?.workspaceFiles);
    return yield* withState(
      (stateDir) =>
        Effect.gen(function* () {
          const spec = sessionSpec(name, cwd, variant.modelSelection);
          const handle = yield* (yield* ThreadRuntime.ThreadRuntime).open(spec);
          const assertT3Output = scenarioResult(handle).pipe(
            Effect.map((result) => variant.assertOutput(result, transcript)),
          );
          const prompt = sendMessage(spec, message.text, variant.modelSelection);
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
 * Waits until the handle's snapshot satisfies `done`, reading only `snapshot()`: nothing
 * subscribes to the thread's events while it waits.
 */
const waitForSnapshot = (
  handle: ThreadRuntime.ThreadHandle,
  done: (projection: OrchestrationV2ThreadProjection) => boolean,
  timeout: Duration.Input = Duration.seconds(30),
) =>
  Effect.gen(function* () {
    while (!done(handle.snapshot())) yield* Effect.sleep(Duration.millis(10));
    return handle.snapshot();
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => {
        const { runs, turnItems } = handle.snapshot();
        const seen = `runs ${runs.map((run) => run.status)}, items ${turnItems.map((item) => (item.type === 'error' ? `error: ${item.failure.message}` : item.type))}`;
        return Effect.die(new Error(`the snapshot never got there: ${seen}`));
      },
    }),
  );

const statuses = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.map((candidate) => candidate.status);

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
        withHostSession({}, () =>
          Effect.gen(function* () {
            // Hydration probes every installed CLI; on this machine each is a fake that records it.
            yield* Effect.gen(function* () {
              while (!machine.calls().some((call) => call.cli === 'claude')) {
                yield* Effect.sleep(Duration.millis(20));
              }
            }).pipe(Effect.timeout(Duration.seconds(20)), Effect.orDie);
            const calls = machine.calls();
            expect(calls.map((call) => call.cli)).toContain('claude');
            for (const call of calls) {
              expect(FAKE_CLIS).toContain(call.cli);
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
