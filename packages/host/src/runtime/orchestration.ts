// @effect-diagnostics nodeBuiltinImport:off - The host's home is read from the OS once per build.
import { homedir } from 'node:os';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import type { ProviderInstanceConfig, ProviderInstanceConfigMap } from '@t3tools/contracts';
import * as AcpRegistrySupport from '@t3tools/provider-acp-registry/server/AcpRegistrySupport';
import { ClaudeAdapterV2 } from '@t3tools/provider-claude/server';
import type { AnyProviderDriver } from '@t3tools/provider-core/server/driver';
import * as ProviderContinuationRequests from '@t3tools/provider-core/server/ProviderContinuationRequests';
import * as ProviderEventLoggers from '@t3tools/provider-core/server/ProviderEventLoggers';
import * as ProviderLatestVersions from '@t3tools/provider-core/server/ProviderLatestVersions';
import * as OpenCodeRuntime from '@t3tools/provider-opencode/server/OpenCodeRuntime';
import * as OpenCodeServerLedger from '@t3tools/provider-opencode/server/OpenCodeServerLedger';
import * as OtelEnvironment from '@t3tools/shared/otelEnvironment';
import { DEFAULT_SIGNAL_EXPORT } from '@t3tools/shared/observability';
import * as HostProcess from '@t3tools/shared/HostProcess';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as CheckpointStore from 't3/checkpointing/CheckpointStore.ts';
import * as ServerConfig from 't3/config.ts';
import * as BackgroundPolicy from 't3/background/BackgroundPolicy.ts';
import * as HostPowerMonitor from 't3/background/HostPowerMonitor.ts';
import * as ServerEnvironment from 't3/environment/ServerEnvironment.ts';
import * as GitManager from 't3/git/GitManager.ts';
import * as GitWorkflowService from 't3/git/GitWorkflowService.ts';
import * as CodexAdapterV2 from 't3/orchestration-v2/Adapters/CodexAdapterV2.ts';
import * as EffectWorker from 't3/orchestration-v2/EffectWorker.ts';
import * as Orchestrator from 't3/orchestration-v2/Orchestrator.ts';
import * as ProjectionStore from 't3/orchestration-v2/ProjectionStore.ts';
import * as ProjectStore from 't3/orchestration-v2/ProjectStore.ts';
import * as ProviderContinuationService from 't3/orchestration-v2/ProviderContinuationService.ts';
import * as ProviderRuntimeRecoveryService from 't3/orchestration-v2/ProviderRuntimeRecoveryService.ts';
import * as ProviderSessionManager from 't3/orchestration-v2/ProviderSessionManager.ts';
import * as RuntimeLayer from 't3/orchestration-v2/runtimeLayer.ts';
import * as SqlitePersistence from 't3/persistence/Sqlite.ts';
import * as ManagedPolicy from 't3/policy/ManagedPolicy.ts';
import * as ManagedProviders from 't3/policy/managedProviders.ts';
import * as PortScanner from 't3/preview/PortScanner.ts';
import * as WorktreeSetupTracker from 't3/project/WorktreeSetupTracker.ts';
import * as CodexInstallation from 't3/provider/CodexInstallation.ts';
import * as CodexManagedTokenBroker from 't3/provider/CodexManagedTokenBroker.ts';
import * as ModelManifest from 't3/provider/ModelManifest.ts';
import * as ProviderHostLive from 't3/provider/ProviderHostLive.ts';
import * as ProviderInstallationGate from 't3/provider/ProviderInstallationGate.ts';
import * as ProviderInstanceRegistry from 't3/provider/ProviderInstanceRegistry.ts';
import * as ProviderInstanceRegistryHydration from 't3/provider/ProviderInstanceRegistryHydration.ts';
import * as ProviderOrchestrationAdapterInfrastructure from 't3/provider/ProviderOrchestrationAdapterInfrastructure.ts';
import * as ResetCreditCoordinator from 't3/provider/resetCreditCoordinator.ts';
import * as PullRequestFilesViewed from 't3/persistence/PullRequestFilesViewed.ts';
import * as ProcessRunner from 't3/processRunner.ts';
import * as ProjectEnrichmentService from 't3/project/ProjectEnrichmentService.ts';
import * as ProjectFaviconResolver from 't3/project/ProjectFaviconResolver.ts';
import * as T3ProjectFileLoader from 't3/project/T3ProjectFileLoader.ts';
import * as RepositoryIdentityResolver from 't3/project/RepositoryIdentityResolver.ts';
import * as ProviderRegistry from 't3/provider/ProviderRegistry.ts';
import * as PullRequestProviderRegistry from 't3/pullRequest/PullRequestProviderRegistry.ts';
import * as PullRequestReadCache from 't3/pullRequest/PullRequestReadCache.ts';
import * as PullRequestService from 't3/pullRequest/PullRequestService.ts';
import * as WorkspacePaths from 't3/workspace/WorkspacePaths.ts';
import * as SourceControlRateLimit from '@t3tools/source-control-core/server/SourceControlRateLimit';
import * as IdAllocator from '@t3tools/provider-core/server/IdAllocator';
import * as SecretResolver from 't3/secrets/SecretResolver.ts';
import * as ServerSettings from 't3/serverSettings.ts';
import * as SourceControlBuiltInDrivers from 't3/sourceControl/builtInDrivers.ts';
import * as SourceControlProviderRegistry from 't3/sourceControl/SourceControlProviderRegistry.ts';
import * as TextGeneration from 't3/textGeneration/TextGeneration.ts';
import * as GitVcsDriver from 't3/vcs/GitVcsDriver.ts';
import * as VcsDriverRegistry from 't3/vcs/VcsDriverRegistry.ts';
import * as VcsProcess from 't3/vcs/VcsProcess.ts';
import * as VcsProjectConfig from 't3/vcs/VcsProjectConfig.ts';
import * as TaskFolders from 't3/workspace/TaskFolders.ts';
import * as TaskFolderStore from 't3/workspace/TaskFolderStore.ts';
import type { SessionSpec } from '../core/sessionSpec.ts';
import { hostDriverFor } from './drivers.ts';
import * as HostStandIns from './standIns.ts';

export interface OrchestrationOptions {
  /** Where t3's server paths live (`userdata/`, `caches/`, `worktrees/`). */
  readonly stateDir: string;
  /** The session's harness: the one provider the composition hydrates (`hostDriverFor`). */
  readonly harness: SessionSpec['harness'];
}

/** t3's `ServerConfig` for a host: t3's own paths under `stateDir`, and no HTTP server. */
const layerServerConfig = (stateDir: string) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const paths = yield* ServerConfig.deriveServerPaths(stateDir, undefined, {
        baseDirIsExplicit: true,
      });
      yield* ServerConfig.ensureServerDirectories(paths);
      return ServerConfig.ServerConfig.of({
        logLevel: 'Info',
        traceMinLevel: 'Info',
        traceTimingEnabled: false,
        traceBatchWindowMs: 200,
        traceMaxBytes: 10 * 1024 * 1024,
        traceMaxFiles: 10,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpLogsUrl: undefined,
        otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
        otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
        otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
        otelEnvironment: OtelEnvironment.none,
        mode: 'web',
        port: 0,
        host: undefined,
        cwd: stateDir,
        baseDir: stateDir,
        ...paths,
        staticDir: undefined,
        devUrl: undefined,
        devAllowedOrigins: [],
        noBrowser: true,
        startupPresentation: 'browser',
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      });
    }),
  );

/**
 * A Codex instance in t3's managed mode: t3 signs a ChatGPT account in itself, keeps its tokens in
 * its secret store and calls OpenAI with them (`CodexManagedProvider.ts`, `CodexChatGptAuth.ts`).
 * The host runs only the person's own `codex` with its own login, so it never hydrates one.
 */
const isManagedCodex = (entry: ProviderInstanceConfig): boolean =>
  entry.driver === 'codex' &&
  typeof entry.config === 'object' &&
  entry.config !== null &&
  (entry.config as { readonly setupMode?: unknown }).setupMode === 'managed';

/**
 * t3's provider instances, hydrated as `ProviderInstanceRegistryHydration.layer` does, but from
 * `drivers` rather than t3's `BUILT_IN_DRIVERS` (which include Cursor): the instances t3 derives
 * from the settings, for those drivers only, over the adapters' own infrastructure.
 */
const layerProviderInstances = <R>(drivers: ReadonlyArray<AnyProviderDriver<R>>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const settings = yield* serverSettings.getSettings;
      const kinds = new Set(drivers.map((driver) => driver.driverKind));
      const configMap: ProviderInstanceConfigMap = Object.fromEntries(
        Object.entries(
          ProviderInstanceRegistryHydration.deriveProviderInstanceConfigMap(settings),
        ).filter(([, entry]) => kinds.has(entry.driver) && !isManagedCodex(entry)),
      );
      const hostEnvironment = ManagedProviders.providerHostEnvironment(
        serverSettings.managedPolicy,
        yield* HostProcess.Environment,
      );
      return ProviderInstanceRegistry.layer({
        drivers,
        configMap,
        blockedReason: (driver) =>
          ManagedProviders.disallowedDriverReason(serverSettings.managedPolicy, driver),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            ClaudeAdapterV2.layerQueryRunner,
            CodexAdapterV2.layerAppServerClientFactory,
            ProviderOrchestrationAdapterInfrastructure.layerIdAllocator,
            // The same reference the runtime layer uses, so both share one request queue.
            ProviderContinuationRequests.layer,
          ),
        ),
        // Drivers launch from the host's environment less what a managed policy ignores, as in
        // t3's hydration.
        Layer.provide(Layer.succeed(HostProcess.Environment, hostEnvironment)),
        Layer.provide(AcpRegistrySupport.layerFromHost),
        Layer.provide(SecretResolver.layer),
      );
    }),
  );

const layerVcsDriverRegistry = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer));

const layerSourceControlProviderRegistry = SourceControlProviderRegistry.layer.pipe(
  Layer.provideMerge(SourceControlBuiltInDrivers.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
);

const layerPullRequestService = PullRequestService.layer.pipe(
  Layer.provide(PullRequestProviderRegistry.layer),
  Layer.provide(PullRequestFilesViewed.layer),
  Layer.provide(PullRequestReadCache.layer),
  Layer.provide(layerSourceControlProviderRegistry),
  Layer.provide(SourceControlRateLimit.layer),
);

const layerGitWorkflow = GitWorkflowService.layer.pipe(
  Layer.provideMerge(layerVcsDriverRegistry),
  Layer.provideMerge(
    GitManager.layer.pipe(
      Layer.provide(Layer.merge(ProjectionStore.layer, ProjectStore.layer)),
      Layer.provide(layerPullRequestService.pipe(Layer.provide(RuntimeLayer.layerProjectService))),
      Layer.provideMerge(RuntimeLayer.layerProjectSetupScriptRunner),
      Layer.provideMerge(WorktreeSetupTracker.layer),
      Layer.provideMerge(GitVcsDriver.layer),
      Layer.provideMerge(layerSourceControlProviderRegistry),
      Layer.provideMerge(
        TextGeneration.layer.pipe(Layer.provide(layerSourceControlProviderRegistry)),
      ),
    ),
  ),
);

const layerTaskFolders = TaskFolders.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      TaskFolderStore.layer,
      ProjectStore.layer,
      ProjectionStore.layer,
      VcsProcess.layer,
    ),
  ),
  Layer.provide(layerGitWorkflow),
);

/**
 * What t3's `server.ts` builds beneath the runtime for its providers and settings: the server's
 * config, in-memory SQLite, settings, t3's provider host and the services the provider drivers
 * read. All t3's own, but the secret store (`standIns.ts`), the event loggers (t3's no-op) and
 * the port scanner (t3's mock).
 */
/** t3's config, persistence, settings and background policy beneath its provider services. */
const layerServerBase = (stateDir: string) =>
  BackgroundPolicy.layer.pipe(
    // t3's power monitor with no desktop app to report the host's power state: unknown.
    Layer.provideMerge(Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make())),
    Layer.provideMerge(ServerSettings.layer.pipe(Layer.provideMerge(ManagedPolicy.layer))),
    Layer.provideMerge(HostStandIns.layerSecretStore),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(layerServerConfig(stateDir)),
    // The host process's own environment and home, read when the composition is built, so every
    // t3 service agrees with what a CLI it starts inherits (t3 caches its defaults for good).
    Layer.provideMerge(Layer.sync(HostProcess.Environment, () => process.env)),
    Layer.provideMerge(Layer.sync(HostProcess.HomeDirectory, () => homedir())),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const layerServerInfrastructure = (stateDir: string, harness: SessionSpec['harness']) =>
  OpenCodeRuntime.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return OpenCodeServerLedger.layer({ stateDir: config.stateDir });
        }),
      ),
    ),
    Layer.provideMerge(CodexManagedTokenBroker.layer),
    // t3's probes the machine's `codex` as it is built; only a Codex session runs Codex.
    Layer.provideMerge(
      harness === 'codex'
        ? CodexInstallation.CodexInstallation.layer
        : HostStandIns.layerNoCodexInstallation,
    ),
    // t3's own provider host, over the same config, settings and (refusing) secret store.
    Layer.provideMerge(ProviderHostLive.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(ModelManifest.layerModelCatalog),
    Layer.provideMerge(ModelManifest.layer),
    Layer.provideMerge(ResetCreditCoordinator.layer),
    Layer.provideMerge(ProviderLatestVersions.layer),
    Layer.provideMerge(ProviderInstallationGate.layer),
    // The host previews no ports, so it tracks no agent's listeners.
    Layer.provideMerge(PortScanner.layerTest),
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(layerServerBase(stateDir)),
  );

/**
 * t3's orchestration core (`runtimeLayer.ts` `layer`) with its event infrastructure and t3's
 * provider-continuation worker, over the infrastructure t3's `server.ts` gives it, less the HTTP
 * server, with provider instances hydrated from `drivers`. Every service is t3's own but those in
 * `standIns.ts`.
 */
const makeOrchestration = <R>(
  options: OrchestrationOptions,
  drivers: ReadonlyArray<AnyProviderDriver<R>>,
) =>
  Layer.mergeAll(
    RuntimeLayer.layer,
    // t3's worker for the requests adapters queue (a background task's wake-up), as
    // `layerProduction` runs it.
    ProviderContinuationService.layer.pipe(
      Layer.provide(ProviderContinuationRequests.layer),
      Layer.provide(RuntimeLayer.layer),
    ),
  ).pipe(
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(RuntimeLayer.layerEventInfrastructure),
    Layer.provide(CheckpointStore.layer.pipe(Layer.provide(layerVcsDriverRegistry))),
    Layer.provide(layerTaskFolders),
    Layer.provide(layerGitWorkflow),
    Layer.provide(layerSourceControlProviderRegistry),
    Layer.provide(ProjectEnrichmentService.layer),
    Layer.provide(
      Layer.mergeAll(
        RepositoryIdentityResolver.layer,
        ProjectFaviconResolver.layer.pipe(Layer.provide(T3ProjectFileLoader.layer)),
      ),
    ),
    Layer.provide(WorkspacePaths.layer),
    // Merged, not only provided: the server-config RPCs read t3's provider list from it.
    Layer.provideMerge(ProviderRegistry.layer),
    Layer.provideMerge(layerProviderInstances(drivers)),
    Layer.provide(HostStandIns.layerMcp),
    Layer.provide(HostStandIns.layerTerminals),
    Layer.provideMerge(Layer.mergeAll(IdAllocator.layer, VcsProcess.layer, ProcessRunner.layer)),
    Layer.provideMerge(layerServerInfrastructure(options.stateDir, options.harness)),
  );

/**
 * The host's orchestration: one provider instance, hydrated from the guarded driver of the
 * session's harness only (`hostDriverFor`).
 */
export const layerOrchestration = (options: OrchestrationOptions) =>
  makeOrchestration(options, [hostDriverFor(options.harness)]);

/**
 * The orchestration over other drivers, for tests only (t3's replay adapter in place of a CLI):
 * `boundary.test.ts` refuses every name ending in `ForTests` outside tests and other seams.
 */
export const layerOrchestrationForTests = <R>(
  options: OrchestrationOptions,
  drivers: ReadonlyArray<AnyProviderDriver<R>>,
) => makeOrchestration(options, drivers);

/**
 * t3's startup and shutdown of the orchestration, in the order `serverRuntimeStartup.ts` runs
 * them (less keybindings, legacy imports and the HTTP server): start the settings runtime,
 * recover provider runtimes, recover delegated tasks, then fork the effect worker that starts
 * turns. Closing the scope prepares providers for shutdown, stops their sessions and reconciles.
 */
export const startOrchestration = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  yield* Effect.addFinalizer(() =>
    recovery.prepareForShutdown.pipe(
      Effect.ensuring(providerSessions.shutdown),
      Effect.andThen(recovery.reconcile('shutdown')),
      Effect.catchCause((cause) =>
        Effect.logWarning('Orchestration shutdown reconciliation failed', cause),
      ),
    ),
  );
  yield* settings.start;
  yield* recovery.recover;
  yield* orchestrator.recoverDelegatedTasks;
  yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
});
