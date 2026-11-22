import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ThreadId,
} from '@t3tools/contracts';
import type * as McpProviderSessions from '@t3tools/provider-core/server/McpProviderSessions';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import type * as Scope from 'effect/Scope';
import * as Semaphore from 'effect/Semaphore';
import * as Stream from 'effect/Stream';
import * as Orchestrator from 't3/orchestration-v2/Orchestrator.ts';
import type * as ProviderAdapterRegistry from 't3/orchestration-v2/ProviderAdapterRegistry.ts';
import type { RuntimePolicyV2Override } from 't3/orchestration-v2/RuntimePolicy.ts';
import * as ProviderReplayHarness from 't3/orchestration-v2/testkit/ProviderReplayHarness.ts';
import { decideCommand } from '../core/commandPolicy.ts';
import type { SessionSpec } from '../core/sessionSpec.ts';
import { defaultModelSelection } from './drivers.ts';

/** One stored event of the thread: `{ sequence, event }`, and the command that caused it. */
export type ThreadEvent = OrchestrationV2StoredEvent;

/** One Consola session, run as one t3 thread whose id is the session id. */
export type ThreadHandle = {
  /**
   * The thread's projection as t3's server reads it (`getThreadSnapshot`), kept current whether
   * or not anything reads `events`. Project it for the wire before sending, as t3's `ws.ts` does.
   */
  snapshot(): OrchestrationV2ThreadProjection;
  /** The last stored event `snapshot()` holds, as t3's snapshot item carries it. */
  snapshotSequence(): number;
  /**
   * Every event of the thread from its first, then live, projected for the wire as t3's
   * `streamStoredEventsFrom` gives them. Each run of the stream is its own subscription; to join
   * it to a snapshot, drop the events at or below that snapshot's sequence.
   */
  events: Stream.Stream<ThreadEvent, ThreadRuntimeError>;
  /** Runs one of the commands the host offers (`decideCommand`); refuses every other. */
  dispatch(
    command: OrchestrationV2Command,
  ): Effect.Effect<void, NotOfferedError | ThreadRuntimeError>;
  /** When the thread last did anything: a stored event or a dispatch, in epoch milliseconds. */
  lastActivityMs(): number;
};

export class ThreadRuntimeError extends Schema.TaggedError<ThreadRuntimeError>()(
  'ThreadRuntimeError',
  {
    sessionId: Schema.String,
    operation: Schema.Literals(['open', 'dispatch', 'events']),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Session ${this.sessionId} failed to ${this.operation}.`;
  }
}

export class NotOfferedError extends Schema.TaggedError<NotOfferedError>()('NotOfferedError', {
  commandType: Schema.String,
}) {
  override get message(): string {
    return `This host does not offer ${this.commandType}.`;
  }
}

export interface ThreadRuntimeOptions<E> {
  /**
   * The adapter registry a session's harness runs on: `hostAdapters` for the person's CLI, or one
   * of t3's replay harnesses in a test.
   */
  readonly adapters: (
    spec: SessionSpec,
  ) => Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    E,
    McpProviderSessions.McpProviderSessions
  >;
  /** The approval and sandbox policy every turn runs under. The cwd is the session's. */
  readonly runtimePolicy?: Omit<RuntimePolicyV2Override, 'cwd'>;
}

export class ThreadRuntime extends Context.Service<
  ThreadRuntime,
  {
    readonly open: (
      spec: SessionSpec,
    ) => Effect.Effect<ThreadHandle, ThreadRuntimeError, Scope.Scope>;
  }
>()('@consola/host/runtime/threadRuntime') {}

/** The one project of a host's thread: t3 files every thread under a project. */
const HOST_PROJECT_ID = ProjectId.make('project:consola-host');

/**
 * Each `open` builds t3's OrchestratorV2 the way t3's replay harness does (`layerWithRegistry`,
 * over in-memory SQLite) in the caller's scope, then creates the session's thread. Closing the
 * scope stops the provider session and drops the thread.
 */
export const layer = <E>(options: ThreadRuntimeOptions<E>): Layer.Layer<ThreadRuntime> =>
  Layer.succeed(
    ThreadRuntime,
    ThreadRuntime.of({
      open: Effect.fn('ThreadRuntime.open')(function* (spec: SessionSpec) {
        const sessionId = spec.sessionId;
        const threadId = ThreadId.make(sessionId);
        const failed = (operation: ThreadRuntimeError['operation']) => (cause: unknown) =>
          new ThreadRuntimeError({ sessionId, operation, cause });

        const context = yield* Layer.build(
          ProviderReplayHarness.layerWithRegistry(
            { name: sessionId, runtimePolicyOverride: { ...options.runtimePolicy, cwd: spec.cwd } },
            options.adapters(spec),
          ),
        ).pipe(Effect.mapError(failed('open')));
        const orchestrator = Context.get(context, Orchestrator.OrchestratorV2);

        yield* orchestrator
          .dispatch({
            type: 'thread.create',
            createdBy: 'user',
            creationSource: 'web',
            commandId: CommandId.make(`command:${sessionId}:thread.create`),
            threadId,
            projectId: HOST_PROJECT_ID,
            title: 'New thread',
            modelSelection: spec.modelSelection ?? defaultModelSelection(spec.harness),
            runtimeMode: 'full-access',
            interactionMode: 'default',
            branch: null,
            worktreePath: null,
          })
          .pipe(Effect.mapError(failed('open')));

        let current = yield* orchestrator
          .getThreadSnapshot(threadId)
          .pipe(Effect.mapError(failed('open')));
        let lastActivity = yield* Clock.currentTimeMillis;
        const reading = yield* Semaphore.make(1);
        // Reads the projection again; a slower read never replaces a newer one.
        const refresh = reading.withPermits(1)(
          Effect.gen(function* () {
            const next = yield* orchestrator.getThreadSnapshot(threadId);
            if (next.snapshotSequence >= current.snapshotSequence) current = next;
            lastActivity = yield* Clock.currentTimeMillis;
          }),
        );

        // Every stored event refreshes the snapshot, so a request waits there with no one
        // watching. `streamStoredEvents` is the unbounded subscription t3 gives its workers.
        yield* orchestrator.streamStoredEvents.pipe(
          Stream.filter((stored) => stored.sequence > current.snapshotSequence),
          Stream.runForEachArray(() =>
            refresh.pipe(
              Effect.catchCause((cause) =>
                Effect.logError('Session snapshot refresh failed.', cause),
              ),
            ),
          ),
          Effect.catchCause((cause) => Effect.logError('Session event stream ended.', cause)),
          Effect.forkScoped,
        );

        const handle: ThreadHandle = {
          snapshot: () => current.projection,
          snapshotSequence: () => current.snapshotSequence,
          events: orchestrator
            .streamStoredEventsFrom({ threadId })
            .pipe(Stream.mapError(failed('events'))),
          dispatch: Effect.fn('ThreadHandle.dispatch')(function* (command) {
            if (decideCommand(command.type) === 'not-offered') {
              return yield* new NotOfferedError({ commandType: command.type });
            }
            yield* orchestrator
              .dispatch(command)
              .pipe(Effect.andThen(refresh), Effect.mapError(failed('dispatch')));
          }),
          lastActivityMs: () => lastActivity,
        };
        return handle;
      }),
    }),
  );
