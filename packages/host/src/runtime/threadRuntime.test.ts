// @effect-diagnostics nodeBuiltinImport:off - The missing-CLI cases make temporary folders.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from '@t3tools/contracts';
import { ClaudeOrchestratorReplayHarness } from '@t3tools/provider-claude/testing';
import { checkpointWorkspace } from '@t3tools/provider-testing/replayWorkspace';
import {
  ORCHESTRATOR_REPLAY_FIXTURES,
  type OrchestratorV2ScenarioResult,
  ProviderReplayFixtures,
} from '@t3tools/server-orchestration/testing';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import type * as Scope from 'effect/Scope';
import * as Stream from 'effect/Stream';
import { materializeReplayTranscriptRuntimeInstructions } from 't3/orchestration-v2/testkit/ReplayRuntimeInstructions.ts';
import { describe, expect, it } from 'vite-plus/test';
import type { SessionSpec } from '../core/sessionSpec.ts';
import { hostAdapters } from './drivers.ts';
import * as ThreadRuntime from './threadRuntime.ts';

/** A replay runs a whole recorded turn through t3's orchestrator; under load that takes a while. */
const REPLAY_TIMEOUT_MS = 60_000;

const sessionSpec = (name: string, cwd: string, modelSelection?: ModelSelection): SessionSpec => ({
  sessionId: `session-sprocket-${name}`,
  harness: 'claude',
  cwd,
  ...(modelSelection === undefined ? {} : { modelSelection }),
});

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
 * Opens a session that replays the recorded Claude variant of one of t3's fixtures, under the
 * fixture's policy, in a git workspace of its own, and runs `body` on it.
 */
const withReplay = <A, E>(
  name: string,
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
    const policy = variant.runtimePolicyOverride;
    const runtime = ThreadRuntime.layer({
      adapters: () => ClaudeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript),
      ...(policy === undefined ? {} : { runtimePolicy: policy }),
    });
    return yield* Effect.gen(function* () {
      const spec = sessionSpec(name, cwd, variant.modelSelection);
      const handle = yield* (yield* ThreadRuntime.ThreadRuntime).open(spec);
      const assertT3Output = scenarioResult(handle).pipe(
        Effect.map((result) => variant.assertOutput(result, transcript)),
      );
      const prompt = sendMessage(spec, message.text, variant.modelSelection);
      return yield* body({ spec, handle, prompt, assertT3Output });
    }).pipe(Effect.scoped, Effect.provide(runtime));
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
        const seen = `runs ${runs.map((run) => run.status)}, items ${turnItems.map((item) => item.type)}`;
        return Effect.die(new Error(`the snapshot never got there: ${seen}`));
      },
    }),
  );

const statuses = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.map((candidate) => candidate.status);

/**
 * What t3's scenario runner hands a fixture's `assertOutput`, read from the handle: every stored
 * event in sequence and the thread's projection. The host serves one thread and no thread list,
 * so its shell snapshot lists none.
 */
const scenarioResult = Effect.fn('scenarioResult')(function* (
  handle: ThreadRuntime.ThreadHandle,
): Effect.fn.Return<OrchestratorV2ScenarioResult, ThreadRuntime.ThreadRuntimeError> {
  const through = handle.snapshotSequence();
  const projection = handle.snapshot();
  const storedEvents = Array.from(
    yield* handle.events.pipe(
      Stream.takeUntil((stored) => stored.sequence >= through),
      Stream.runCollect,
    ),
  );
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
    'simple: a message gets one answer, and the run completes',
    () =>
      withReplay('simple', ({ spec, handle, prompt, assertT3Output }) =>
        Effect.gen(function* () {
          expect(handle.snapshot().thread.id).toBe(spec.sessionId);

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
          yield* assertT3Output;
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  it(
    'turn_interrupt: interrupting the run leaves it interrupted',
    () =>
      withReplay('turn_interrupt', ({ spec, handle, prompt, assertT3Output }) =>
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

  it(
    'tool_call_read_only: Claude reads two files without asking, and the turn completes',
    () =>
      withReplay('tool_call_read_only', ({ handle, prompt, assertT3Output }) =>
        Effect.gen(function* () {
          yield* handle.dispatch(prompt);
          const projection = yield* waitForSnapshot(handle, (current) =>
            statuses(current).includes('completed'),
          );

          expect(statuses(projection)).toEqual(['completed']);
          expect(projection.turnItems.filter((item) => item.type === 'dynamic_tool')).toHaveLength(
            2,
          );
          // t3 recorded this one under a policy that never asks: no runtime request.
          expect(projection.runtimeRequests).toEqual([]);
          yield* assertT3Output;
        }),
      ),
    REPLAY_TIMEOUT_MS,
  );

  // Review Focus 3: an approval that arrives while no client is connected.
  it(
    'tool_call_restricted_granular: an approval waits in the snapshot with no subscriber, then resolves',
    () =>
      withReplay('tool_call_restricted_granular', ({ spec, handle, prompt, assertT3Output }) =>
        Effect.gen(function* () {
          yield* handle.dispatch(prompt).pipe(Effect.forkScoped);
          // Nothing reads `events` in this test: the request reaches the snapshot by itself.
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
            commandId: CommandId.make(`command:${spec.sessionId}:approve-1`),
            threadId: ThreadId.make(spec.sessionId),
            requestId: request.id,
            decision: 'accept',
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

  describe('with the person’s CLI (hostAdapters)', () => {
    /** Runs `body` on a session started on `hostAdapters`, in temporary folders. */
    const withHostSession = <A, E>(
      settings: Omit<Parameters<typeof hostAdapters>[0], 'stateDir' | 'env'>,
      env: (emptyBin: string) => Record<string, string | undefined>,
      body: (session: {
        spec: SessionSpec;
        handle: ThreadRuntime.ThreadHandle;
      }) => Effect.Effect<A, E, Scope.Scope>,
    ) => {
      const stateDir = mkdtempSync(join(tmpdir(), 'consola-host-state-'));
      const emptyBin = mkdtempSync(join(tmpdir(), 'consola-host-bin-'));
      const cwd = mkdtempSync(join(tmpdir(), 'consola-host-cwd-'));
      const runtime = ThreadRuntime.layer({
        adapters: hostAdapters({ stateDir, env: env(emptyBin), ...settings }),
      });
      return Effect.gen(function* () {
        const spec = sessionSpec('host', cwd);
        const handle = yield* (yield* ThreadRuntime.ThreadRuntime).open(spec);
        return yield* body({ spec, handle });
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime),
        Effect.ensuring(
          Effect.sync(() => {
            for (const dir of [stateDir, emptyBin, cwd])
              rmSync(dir, { recursive: true, force: true });
          }),
        ),
        Effect.runPromise,
      );
    };

    const MISSING_BINARY = { claude: { binaryPath: '/nonexistent/sprocket/bin/claude' } };
    const inheritedEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME });

    it('refuses thread.fork with NotOfferedError, before the orchestrator sees it', () =>
      withHostSession(MISSING_BINARY, inheritedEnv, ({ spec, handle }) =>
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
      ));

    it('fails to open a harness that is not wired yet, saying which', async () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'consola-host-state-'));
      try {
        const runtime = ThreadRuntime.layer({ adapters: hostAdapters({ stateDir, env: {} }) });
        const error = await Effect.gen(function* () {
          return yield* (yield* ThreadRuntime.ThreadRuntime).open({
            ...sessionSpec('codex', stateDir),
            harness: 'codex',
          });
        }).pipe(Effect.flip, Effect.scoped, Effect.provide(runtime), Effect.runPromise);

        expect(error).toMatchObject({ _tag: 'ThreadRuntimeError', operation: 'open' });
        expect(error.cause).toMatchObject({ _tag: 'HarnessNotWiredError', harness: 'codex' });
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    // Review Focus 1: a missing CLI ends in the thread as a failure, never as a spinner.
    it.each([
      ['a binary path that does not exist', MISSING_BINARY, inheritedEnv],
      [
        'a PATH with no claude on it',
        {},
        (emptyBin: string) => ({ PATH: emptyBin, HOME: process.env.HOME }),
      ],
    ] as const)(
      'missing CLI (%s): the run fails with an error item within 5 s',
      (_case, settings, env) =>
        withHostSession(settings, env, ({ spec, handle }) =>
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
            const error = projection.turnItems.find((item) => item.type === 'error');
            expect(error?.type === 'error' && error.failure.message).toMatch(
              /Claude Code process exited with code \d+ before it started/,
            );
          }),
        ),
      REPLAY_TIMEOUT_MS,
    );
  });
});
