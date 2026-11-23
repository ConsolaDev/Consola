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
import * as Cause from 'effect/Cause';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import * as Schema from 'effect/Schema';
import type * as Scope from 'effect/Scope';
import * as Semaphore from 'effect/Semaphore';
import * as Stream from 'effect/Stream';
import * as SubscriptionRef from 'effect/SubscriptionRef';
import * as ServerConfig from 't3/config.ts';
import * as CommandOutputHub from 't3/orchestration-v2/CommandOutputHub.ts';
import * as Orchestrator from 't3/orchestration-v2/Orchestrator.ts';
import * as ProjectService from 't3/project/ProjectService.ts';
import * as ProviderRegistry from 't3/provider/ProviderRegistry.ts';
import * as ServerSettings from 't3/serverSettings.ts';
import { decideCommand } from '../core/commandPolicy.ts';
import type { SessionSpec } from '../core/sessionSpec.ts';
import {
  defaultModelSelection,
  type HostDriversEnv,
  hostDriverFor,
  titleModelSelection,
} from './drivers.ts';
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
   * `snapshot()` now, then each projection that replaces it: one per refresh, after every stored
   * event and every dispatch, so a reader sees what `snapshot()` would answer at that moment.
   */
  snapshots(): Stream.Stream<OrchestrationV2ThreadProjection>;
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
  /**
   * Fails once the stream that keeps `snapshot()` current ends (t3's `streamStoredEvents`, which
   * runs as long as the orchestration does): from then on the snapshot, the status and the title
   * would go stale, so the session must stop. Never succeeds; closing the scope ends it quietly.
   */
  readonly ended: Effect.Effect<never, ThreadStreamEnded>;
};

/**
 * The services of the session's composition that t3's `ws.ts` builds its server config and
 * provider list from, so the host serves them from the same place: nothing here is faked.
 */
export type ThreadServerView = {
  /**
   * t3's `ProviderRegistry`: one snapshot per provider instance in the `ProviderInstanceRegistry`
   * the composition hydrated from the session's one driver (`hostDriverFor`), its changes, and
   * its refreshes.
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

/** The stream that keeps a session's snapshot current ended (`ThreadHandle.ended`). */
export class ThreadStreamEnded extends Schema.TaggedError<ThreadStreamEnded>()(
  'ThreadStreamEnded',
  { sessionId: Schema.String },
) {
  override get message(): string {
    return `Session ${this.sessionId} stopped: its thread's event stream ended, so what it shows would go stale.`;
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
  /**
   * Drivers in place of the session's guarded driver (`hostDriverFor`), such as Claude's driver
   * on t3's replay adapter.
   */
  readonly drivers?: ReadonlyArray<AnyProviderDriver<HostDriversEnv>>;
  /** The mode a replayed fixture was recorded in, in place of `HOST_RUNTIME_MODE`. */
  readonly runtimeMode?: RuntimeMode;
  /**
   * The stream that keeps the snapshot current ends after this many stored events, as if t3's
   * `streamStoredEvents` had ended (`ThreadHandle.ended`).
   */
  readonly endEventsAfter?: number;
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
 * Each `open` builds t3's production orchestration (`layerOrchestration`) for the session's
 * harness in the caller's scope, points t3's thread titles at the session's provider, files the
 * session's folder as its project, and creates its thread. Closing the scope stops the provider
 * session and drops the thread. t3's logs go to stderr.
 */
const make = (
  options: ThreadRuntimeOptions,
  runtimeMode: RuntimeMode,
  orchestration: typeof layerOrchestration,
  endEventsAfter?: number,
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

        const context = yield* Layer.build(
          orchestration({ stateDir: options.stateDir, harness: spec.harness }),
        ).pipe(Effect.mapError(failed('open')), toStderr);
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

        // t3 titles a thread with `textGenerationModelSelection`, Codex by default, whatever the
        // thread runs on. The session's provider is the only one hydrated, so titles go there:
        // a selection already on the session's instance (the state folder's own) is kept.
        const titles = titleModelSelection(spec);
        const settingsNow = yield* settings.getSettings.pipe(Effect.mapError(failed('open')));
        if (settingsNow.textGenerationModelSelection.instanceId !== titles.instanceId) {
          yield* settings
            .updateSettings({ textGenerationModelSelection: titles })
            .pipe(Effect.mapError(failed('open')), toStderr);
        }

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
        const projections = yield* SubscriptionRef.make(current.projection);
        const reading = yield* Semaphore.make(1);
        // Reads the projection again; a slower read never replaces a newer one.
        const refresh = reading.withPermits(1)(
          Effect.gen(function* () {
            const next = yield* orchestrator.getThreadSnapshot(threadId);
            if (next.snapshotSequence >= current.snapshotSequence) {
              current = next;
              yield* SubscriptionRef.set(projections, next.projection);
            }
            lastActivity = yield* Clock.currentTimeMillis;
          }),
        );

        // Every stored event refreshes the snapshot, so a request waits there with no one
        // watching. `streamStoredEvents` is the unbounded subscription t3 gives its workers: it
        // ends only with the orchestration, so its end, or its failure, ends the session
        // (`ended`). Its interruption, as the scope closes, is the session's own stop, and quiet.
        const streamEnded = yield* Deferred.make<never, ThreadStreamEnded>();
        const storedEvents =
          endEventsAfter === undefined
            ? orchestrator.streamStoredEvents
            : orchestrator.streamStoredEvents.pipe(Stream.take(endEventsAfter));
        yield* storedEvents.pipe(
          Stream.filter((stored) => stored.sequence > current.snapshotSequence),
          Stream.runForEachArray(() =>
            refresh.pipe(
              Effect.catchCause((cause) =>
                Effect.logError('Session snapshot refresh failed.', cause),
              ),
            ),
          ),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) => Effect.logError('Session event stream failed.', cause),
          ),
          Effect.andThen(Deferred.fail(streamEnded, new ThreadStreamEnded({ sessionId }))),
          toStderr,
          Effect.forkScoped,
        );

        const handle: ThreadHandle = {
          snapshot: () => current.projection,
          snapshotSequence: () => current.snapshotSequence,
          snapshots: () => SubscriptionRef.changes(projections),
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
          ended: Deferred.await(streamEnded),
        };
        return handle;
      }),
    }),
  );

/**
 * The host's thread runtime: each session on its harness's guarded driver alone, every thread in
 * `HOST_RUNTIME_MODE`.
 */
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
  make(
    options,
    seam.runtimeMode ?? HOST_RUNTIME_MODE,
    (orchestrationOptions) =>
      layerOrchestrationForTests(
        orchestrationOptions,
        seam.drivers ?? [hostDriverFor(orchestrationOptions.harness)],
      ),
    seam.endEventsAfter,
  );
