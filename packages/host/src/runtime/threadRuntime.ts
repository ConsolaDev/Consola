// @effect-diagnostics nodeBuiltinImport:off - A session's project is named after its folder.
import { basename } from 'node:path';
import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  type OrchestrationV2CommandOutputError,
  type OrchestrationV2CommandOutputFrame,
  type RuntimeMode,
  ThreadId,
  type TurnItemId,
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
import * as ServerConfig from 't3/config.ts';
import * as CommandOutputHub from 't3/orchestration-v2/CommandOutputHub.ts';
import * as Orchestrator from 't3/orchestration-v2/Orchestrator.ts';
import * as ProjectService from 't3/project/ProjectService.ts';
import * as ProviderRegistry from 't3/provider/ProviderRegistry.ts';
import * as ServerSettings from 't3/serverSettings.ts';
import { decideCommand } from '../core/commandPolicy.ts';
import type { SessionSpec } from '../core/sessionSpec.ts';
import { defaultModelSelection, HOST_DRIVERS, type HostDriversEnv } from './drivers.ts';
import {
  layerOrchestration,
  layerOrchestrationForTests,
  startOrchestration,
} from './orchestration.ts';

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
  /**
   * Runs one of the commands the host offers (`decideCommand`); refuses every other. Answers t3's
   * dispatch result: the sequence the command's events were stored at (a command id already
   * accepted is not run again, and answers its first sequence).
   */
  dispatch(
    command: OrchestrationV2Command,
  ): Effect.Effect<{ readonly sequence: number }, NotOfferedError | ThreadRuntimeError>;
  /**
   * The live output of one of the thread's command rows, from t3's `CommandOutputHub` (the one
   * its provider sessions write to), as t3's `subscribeCommandOutput` serves it.
   */
  commandOutput(
    itemId: TurnItemId,
  ): Stream.Stream<OrchestrationV2CommandOutputFrame, OrchestrationV2CommandOutputError>;
  /** What t3's server-config and provider RPCs read: `ThreadServerView`. */
  readonly server: ThreadServerView;
  /** When the thread last did anything: a stored event or a dispatch, in epoch milliseconds. */
  lastActivityMs(): number;
};

/**
 * The services of the session's composition that t3's `ws.ts` builds its server config and
 * provider list from, so the host serves them from the same place: nothing here is faked.
 */
export type ThreadServerView = {
  /**
   * t3's `ProviderRegistry`: one snapshot per provider instance in the `ProviderInstanceRegistry`
   * the composition hydrated from `HOST_DRIVERS`, its changes, and its refreshes.
   */
  readonly providers: ProviderRegistry.ProviderRegistry['Service'];
  /** t3's settings, as its settings service reads them, and their changes. */
  readonly settings: ServerSettings.ServerSettingsService['Service']['getSettings'];
  readonly settingsChanges: ServerSettings.ServerSettingsService['Service']['subscribeChanges'];
  /** The session's folder: the thread's project, where its turns run. */
  readonly cwd: string;
  /** t3's config paths a server config names: keybindings (not served) and logs. */
  readonly keybindingsConfigPath: string;
  readonly logsDir: string;
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

/**
 * A host's runtime is configured by its state folder alone. The CLIs inherit the host process's
 * environment, as in t3, which is where each finds its own login.
 */
export interface ThreadRuntimeOptions {
  /** Where t3's server paths live; nothing the host keeps there is a credential. */
  readonly stateDir: string;
}

/** What only a test may change: see `layerForTests`. */
export interface ThreadRuntimeTestSeam {
  /** Drivers in place of `HOST_DRIVERS`, such as Claude's driver on t3's replay adapter. */
  readonly drivers?: ReadonlyArray<AnyProviderDriver<HostDriversEnv>>;
  /** The mode a replayed fixture was recorded in, in place of `HOST_RUNTIME_MODE`. */
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
const make = (
  options: ThreadRuntimeOptions,
  runtimeMode: RuntimeMode,
  orchestration: typeof layerOrchestration,
) =>
  Layer.succeed(
    ThreadRuntime,
    ThreadRuntime.of({
      open: Effect.fn('ThreadRuntime.open')(function* (spec: SessionSpec) {
        const sessionId = spec.sessionId;
        const threadId = ThreadId.make(sessionId);
        const failed = (operation: ThreadRuntimeError['operation']) => (cause: unknown) =>
          new ThreadRuntimeError({ sessionId, operation, cause });
        const toStderr = Effect.provideService(Logger.LogToStderr, true);

        const context = yield* Layer.build(orchestration({ stateDir: options.stateDir })).pipe(
          Effect.mapError(failed('open')),
          toStderr,
        );
        yield* startOrchestration.pipe(
          Effect.provideContext(context),
          Effect.mapError(failed('open')),
          toStderr,
        );
        const orchestrator = Context.get(context, Orchestrator.OrchestratorV2);
        const projects = Context.get(context, ProjectService.ProjectService);
        const commandOutput = Context.get(context, CommandOutputHub.CommandOutputHub);
        const settings = Context.get(context, ServerSettings.ServerSettingsService);
        const config = Context.get(context, ServerConfig.ServerConfig);

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
            runtimeMode,
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
            const result = yield* orchestrator
              .dispatch(command)
              .pipe(Effect.tap(refresh), Effect.mapError(failed('dispatch')), toStderr);
            return { sequence: result.sequence };
          }),
          commandOutput: (itemId) => commandOutput.subscribe({ threadId, itemId }),
          server: {
            providers: Context.get(context, ProviderRegistry.ProviderRegistry),
            settings: settings.getSettings,
            settingsChanges: settings.subscribeChanges,
            cwd: spec.cwd,
            keybindingsConfigPath: config.keybindingsConfigPath,
            logsDir: config.logsDir,
          },
          lastActivityMs: () => lastActivity,
        };
        return handle;
      }),
    }),
  );

/** The host's thread runtime: `HOST_DRIVERS`, every thread in `HOST_RUNTIME_MODE`. */
export const layer = (options: ThreadRuntimeOptions): Layer.Layer<ThreadRuntime> =>
  make(options, HOST_RUNTIME_MODE, layerOrchestration);

/**
 * `layer` with the seam t3's replay harness uses, for tests only: `boundary.test.ts` refuses
 * every name ending in `ForTests` outside a test file (but in another seam's own definition, as
 * here), so the host cannot reach it.
 */
export const layerForTests = (
  options: ThreadRuntimeOptions,
  seam: ThreadRuntimeTestSeam,
): Layer.Layer<ThreadRuntime> =>
  make(options, seam.runtimeMode ?? HOST_RUNTIME_MODE, (orchestrationOptions) =>
    layerOrchestrationForTests(orchestrationOptions, seam.drivers ?? HOST_DRIVERS),
  );
