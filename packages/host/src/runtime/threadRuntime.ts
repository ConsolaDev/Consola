// @effect-diagnostics nodeBuiltinImport:off - A session's project is named after its folder.
import { basename } from 'node:path';
import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  type RuntimeMode,
  ThreadId,
} from '@t3tools/contracts';
import type { AnyProviderDriver } from '@t3tools/provider-core/server/driver';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import * as Schema from 'effect/Schema';
import type * as Scope from 'effect/Scope';
import * as Semaphore from 'effect/Semaphore';
import * as Stream from 'effect/Stream';
import * as Orchestrator from 't3/orchestration-v2/Orchestrator.ts';
import * as ProjectService from 't3/project/ProjectService.ts';
import { decideCommand } from '../core/commandPolicy.ts';
import type { SessionSpec } from '../core/sessionSpec.ts';
import { defaultModelSelection, HOST_DRIVERS, type HostDriversEnv } from './drivers.ts';
import { layerOrchestration, startOrchestration } from './orchestration.ts';

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
   * The thread's stored events after `afterSequence` (every one when it is omitted), replayed
   * from storage and then live, projected for the wire as t3's `streamStoredEventsFrom` gives
   * them; each run is its own subscription. To join a snapshot, read `snapshotSequence()` and
   * `snapshot()` together, then pass that sequence: no event is missed or repeated.
   */
  events(afterSequence?: number): Stream.Stream<ThreadEvent, ThreadRuntimeError>;
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

export interface ThreadRuntimeOptions {
  /** Where t3's server paths live; nothing the host keeps there is a credential. */
  readonly stateDir: string;
  /** The environment the CLIs start with, where each finds its own login. */
  readonly env: Record<string, string | undefined>;
  /**
   * For tests only, the seam t3's replay harness uses: drivers in place of `HOST_DRIVERS`, such
   * as Claude's driver with a replay adapter. The host never sets it.
   */
  readonly drivers?: ReadonlyArray<AnyProviderDriver<HostDriversEnv>>;
  /**
   * For tests only: the mode a replayed fixture was recorded in. The host never sets it, so a
   * thread always opens in `approval-required` (see `HOST_RUNTIME_MODE`).
   */
  readonly runtimeMode?: RuntimeMode;
}

/**
 * Every thread opens in t3's mode that asks before a command runs or a file is written. t3's own
 * default (`DEFAULT_RUNTIME_MODE`) is `full-access`, which asks nothing; the host never uses it.
 */
export const HOST_RUNTIME_MODE: RuntimeMode = 'approval-required';

export class ThreadRuntime extends Context.Service<
  ThreadRuntime,
  {
    readonly open: (
      spec: SessionSpec,
    ) => Effect.Effect<ThreadHandle, ThreadRuntimeError, Scope.Scope>;
  }
>()('@consola/host/runtime/threadRuntime') {}

/**
 * Each `open` builds t3's production orchestration (`layerOrchestration`) in the caller's scope,
 * files the session's folder as its project, and creates its thread. Closing the scope stops the
 * provider session and drops the thread. t3's logs go to stderr.
 */
export const layer = (options: ThreadRuntimeOptions): Layer.Layer<ThreadRuntime> =>
  Layer.succeed(
    ThreadRuntime,
    ThreadRuntime.of({
      open: Effect.fn('ThreadRuntime.open')(function* (spec: SessionSpec) {
        const sessionId = spec.sessionId;
        const threadId = ThreadId.make(sessionId);
        const failed = (operation: ThreadRuntimeError['operation']) => (cause: unknown) =>
          new ThreadRuntimeError({ sessionId, operation, cause });
        const toStderr = Effect.provideService(Logger.LogToStderr, true);

        const context = yield* Layer.build(
          layerOrchestration({
            stateDir: options.stateDir,
            env: options.env,
            drivers: options.drivers ?? HOST_DRIVERS,
          }),
        ).pipe(Effect.mapError(failed('open')), toStderr);
        yield* startOrchestration.pipe(
          Effect.provideContext(context),
          Effect.mapError(failed('open')),
          toStderr,
        );
        const orchestrator = Context.get(context, Orchestrator.OrchestratorV2);
        const projects = Context.get(context, ProjectService.ProjectService);

        const projectId = ProjectId.make(`project:${sessionId}`);
        yield* projects
          .create({
            commandId: CommandId.make(`command:${sessionId}:project.create`),
            projectId,
            title: basename(spec.cwd) || spec.cwd,
            workspaceRoot: spec.cwd,
          })
          .pipe(Effect.mapError(failed('open')), toStderr);
        yield* orchestrator
          .dispatch({
            type: 'thread.create',
            createdBy: 'user',
            creationSource: 'web',
            commandId: CommandId.make(`command:${sessionId}:thread.create`),
            threadId,
            projectId,
            title: 'New thread',
            modelSelection: spec.modelSelection ?? defaultModelSelection(spec.harness),
            runtimeMode: options.runtimeMode ?? HOST_RUNTIME_MODE,
            interactionMode: 'default',
            branch: null,
            worktreePath: null,
          })
          .pipe(Effect.mapError(failed('open')), toStderr);

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
          toStderr,
          Effect.forkScoped,
        );

        const handle: ThreadHandle = {
          snapshot: () => current.projection,
          snapshotSequence: () => current.snapshotSequence,
          events: (afterSequence) =>
            orchestrator
              .streamStoredEventsFrom({
                threadId,
                ...(afterSequence === undefined ? {} : { afterSequence }),
              })
              .pipe(Stream.mapError(failed('events'))),
          dispatch: Effect.fn('ThreadHandle.dispatch')(function* (command) {
            if (decideCommand(command.type) === 'not-offered') {
              return yield* new NotOfferedError({ commandType: command.type });
            }
            yield* orchestrator
              .dispatch(command)
              .pipe(Effect.andThen(refresh), Effect.mapError(failed('dispatch')), toStderr);
          }),
          lastActivityMs: () => lastActivity,
        };
        return handle;
      }),
    }),
  );
