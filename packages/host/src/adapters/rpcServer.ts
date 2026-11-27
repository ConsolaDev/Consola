// @effect-diagnostics nodeBuiltinImport:off - The host listens with Node's HTTP server.
import { createServer } from 'node:http';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import {
  CLIENT_CAPABILITIES_QUERY_PARAM,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2CommandOutputError,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetThreadProjectionError,
  ProviderSetupError,
  RpcScopeAuthorization,
  serverProviderDeltas,
  SETTINGS_SECRET_REFERENCES_CAPABILITY,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from '@t3tools/contracts';
import type {
  ExecutionEnvironmentDescriptor,
  OrchestrationV2Command,
  OrchestrationV2SubscribeThreadInput,
  OrchestrationV2ThreadStreamItem,
  ServerAuthDescriptor,
  ServerConfig,
  ServerConfigStreamEvent,
  ServerProvider,
} from '@t3tools/contracts';
import { dedupeSnapshotBodies } from '@t3tools/shared/orchestrationV2DedupedBodies';
import {
  SOCKET_FRAME_PARTS_QUERY_PARAM,
  splitLargeSocketFrames,
} from '@t3tools/shared/socketFrameParts';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as DateTime from 'effect/DateTime';
import * as Deferred from 'effect/Deferred';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import type * as Scope from 'effect/Scope';
import * as Stream from 'effect/Stream';
import * as HttpMiddleware from 'effect/http/HttpMiddleware';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as UrlParams from 'effect/http/UrlParams';
import { RpcGroup, RpcSchema, RpcSerialization, RpcServer } from 'effect/rpc';
import type * as Rpc from 'effect/rpc/Rpc';
import * as Socket from 'effect/socket/Socket';
import {
  coalesceLiveUpdatedEvents,
  coalesceThreadLiveStream,
} from 't3/orchestration-v2/ThreadLiveEventCoalescer.ts';
import { withCreationProvenance } from 't3/orchestration-v2/ThreadManagementService.ts';
import { userFacingDispatchErrorMessage } from 't3/orchestration-v2/UserFacingErrors.ts';
import {
  decideThreadResume,
  THREAD_RESUME_MAX_REPLAY_EVENTS,
  threadReplayEncodedBytes,
} from 't3/orchestration-v2/ThreadStream.ts';
import {
  makeLiveBodyDeduper,
  projectThreadProjectionForWire,
  threadStreamEventItem,
} from 't3/orchestration-v2/WireProjection.ts';
import { rpcInitialItems } from 't3/rpcInitialItems.ts';
import { redactServerSettingsForClient } from 't3/serverSettings.ts';
import { withOutputWindow } from 't3/terminal/OutputProtocol.ts';
import { isLoopback } from '../core/bind.ts';
import type { PassLifetime } from '../core/pass.ts';
import { readableThread } from '../runtime/threadRuntime.ts';
import type { ThreadHandle } from '../runtime/threadRuntime.ts';
import { FOLLOW_UP_PATH, serveFollowUp } from './followUpHttp.ts';
import { serveHostHttp } from './hostHttp.ts';
import { MCP_PATH, serveMcp } from './mcpHttp.ts';
import { subscribeHostShell } from './hostShell.ts';
import { parsePassKey, verifyPassWith } from './passVerifier.ts';
import type { PassKey, PassKeyInvalid } from './passVerifier.ts';
import { makeSocketTickets } from './socketTickets.ts';
import type { SocketTickets } from './socketTickets.ts';

/**
 * The methods of t3's `WsRpcGroup` this host serves; it answers every other with
 * `NotOfferedByHost`. The list is what t3's chat view and composer reach through
 * `@t3tools/client-runtime`:
 *
 * - `orchestration.subscribeThread`, `orchestration.dispatchCommand`,
 *   `orchestration.subscribeCommandOutput`: the thread, its commands (`decideCommand` offers
 *   four) and its command rows' live output (client-runtime `state/threads.ts`,
 *   `state/orchestration.ts`).
 * - `orchestration.subscribeShell`: the thread list's shell, which client-runtime follows for
 *   every environment it connects (`state/shell.ts`) and the chat reads the thread's title and
 *   status from: the session's project and thread alone (`hostShell.ts`).
 * - `subscribeServerConfig`: client-runtime's session (`rpc/session.ts`) subscribes as it
 *   connects and is ready only once its first snapshot arrives; it carries the provider list the
 *   composer's model picker reads.
 * - `server.probe`: the session's liveness check (`rpc/session.ts`).
 * - `server.refreshProviders`: the composer's model picker and its workspace snapshot (slash
 *   commands and skills of the session's folder) (`apps/web` `chat/ProviderModelPicker.tsx`,
 *   `chat/useProviderWorkspaceSnapshotRefresh.ts`).
 */
export const SERVED_METHODS = [
  ORCHESTRATION_V2_WS_METHODS.subscribeThread,
  ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.serverProbe,
  WS_METHODS.serverRefreshProviders,
] as const;

/** `NotOfferedByHost`'s name, which is what a client sees of it (below). */
export const NOT_OFFERED_BY_HOST = 'NotOfferedByHost';

/**
 * A `WsRpcGroup` method this host does not serve. Every method declares t3's own failures and
 * t3's unchanged client decodes only those, so this travels as the request's defect: the client
 * receives a defect named `NotOfferedByHost` whose message names the method, and the socket keeps
 * serving (`disableFatalDefects`).
 */
export class NotOfferedByHost extends Schema.TaggedError<NotOfferedByHost>()(NOT_OFFERED_BY_HOST, {
  method: Schema.String,
}) {
  override get message(): string {
    return `This host does not offer ${this.method}.`;
  }
}

/** The host could not listen at the address it was given. */
export class HostListenError extends Schema.TaggedError<HostListenError>()('HostListenError', {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return 'The host could not listen at its address.';
  }
}

/** A listening host: its port, and how many clients it serves now. */
export interface HostListening {
  readonly port: number;
  /** The RPC connections open now: each socket whose pass was let in, until it closes. */
  readonly connectedClients: () => number;
}

export interface HostServerOptions {
  /** `0` asks for an ephemeral port; `listenHost` answers the one it got. */
  readonly port: number;
  /** The address to bind. The caller chooses it; this server adds no default. */
  readonly host: string;
  /** The one session this host serves: a pass must name it, and it is the thread's id. */
  readonly sessionId: string;
  /** The cell's Ed25519 public key, as an SPKI PEM, that every pass is signed by. */
  readonly publicKeyPem: string;
  /**
   * A `--dev` host (`bin.ts`): its key pair is its own, and it takes the long pass it signed with
   * it (`PassLifetime` `dev`). Only on loopback: `listenHost` refuses one bound anywhere else.
   */
  readonly dev?: boolean;
  readonly runtime: ThreadHandle;
}

/** The path t3's client connects to (`connection/resolver.ts`, t3's `ws.ts` route). */
const WS_PATH = '/ws';
/**
 * Where a client might put a pass. The socket takes none (a ticket alone opens it), but the name
 * is redacted wherever the server shows a URL, so a client that sends one leaves it in no log.
 */
const PASS_QUERY_PARAM = 'pass';
/**
 * Where t3's client puts the ticket it was issued (`authorization/remote.ts`
 * `resolveRemoteWebSocketConnectionUrl`): one of the host's own (`socketTickets.ts`).
 */
const WS_TICKET_QUERY_PARAM = 'wsTicket';
/**
 * The query parameters Effect redacts wherever it shows a URL the server is handling (a request's
 * inspection, a logger's or a tracer's URL): Effect's own list, which a custom list replaces, a
 * pass and the ticket.
 */
export const HOST_REDACTED_URL_PARAMS: ReadonlyArray<string | RegExp> = [
  ...UrlParams.CurrentRedactedNames.defaultValue(),
  PASS_QUERY_PARAM,
  WS_TICKET_QUERY_PARAM,
];
/**
 * t3's `ws.ts` `WS_RPC_SERVER_OPTIONS` (`ws.ts:3676-3680`, reproduced: ws.ts is not lifted): a
 * defect ends its request only, not every request on the socket.
 */
const WS_RPC_SERVER_OPTIONS = { disableTracing: true, disableFatalDefects: true } as const;
/** t3's `PROVIDER_STATUS_DEBOUNCE_MS` (`ws.ts:719`): changes that arrive together are sent once. */
const PROVIDER_STATUS_DEBOUNCE = Duration.millis(200);
/** How long a refused socket is given to answer its close frame. */
const CLOSE_HANDSHAKE_TIMEOUT = Duration.seconds(5);

/** Why a socket is refused: no ticket, or one the host did not issue, used, or expired. */
const TICKET_REFUSED_REASON = 'A valid socket ticket is required.';
/** Why a connection the pass let in is closed (`4401`) at the pass's `exp`. */
const PASS_EXPIRED_REASON = 'The session pass has expired.';

/**
 * The version of the t3 server whose code this host runs: `vendor/t3code/apps/server/package.json`
 * `version` (`rpcServer.test.ts` checks they agree).
 */
export const T3_SERVER_VERSION = '0.1.11';

/**
 * The host is no t3 auth server: a connection is let in by its pass, and that is the only session
 * it holds. t3's client needs a descriptor; `sessionCookieName` is t3's name, and the host sets no
 * cookie.
 */
const HOST_AUTH: ServerAuthDescriptor = {
  policy: 'remote-reachable',
  bootstrapMethods: [],
  sessionMethods: ['bearer-access-token'],
  sessionCookieName: 't3_session',
};

type WsRpc = RpcGroup.Rpcs<typeof WsRpcGroup>;
type ServedMethod = (typeof SERVED_METHODS)[number];
type ServedRpc = Extract<WsRpc, { readonly _tag: ServedMethod }>;
type OtherRpc = Exclude<WsRpc, ServedRpc>;

const servedMethods: ReadonlySet<string> = new Set(SERVED_METHODS);
const isServed = (rpc: WsRpc): rpc is ServedRpc => servedMethods.has(rpc._tag);
const isOther = (rpc: WsRpc): rpc is OtherRpc => !isServed(rpc);
const wsRpcs = Array.from(WsRpcGroup.requests.values());
// Two groups, as t3's `ws.ts` splits its own: typing every handler against every RPC at once
// costs the type checker handlers × RPCs. The refusals are one handler each for some 250
// methods, typed against no method (a refusal reads no payload and answers nothing).
const ServedRpcGroup = RpcGroup.make(...wsRpcs.filter(isServed));
const otherRpcs = wsRpcs.filter(isOther);
const OtherRpcGroup = RpcGroup.make(...otherRpcs) as unknown as RpcGroup.RpcGroup<Rpc.Any>;

/** A handler for a method this host does not serve: a stream or a single answer, as declared. */
const notOffered = (rpc: WsRpc) => {
  const refusal = new NotOfferedByHost({ method: rpc._tag });
  return RpcSchema.isStreamSchema(rpc.successSchema)
    ? () => Stream.die(refusal)
    : () => Effect.die(refusal);
};

/** t3's `readSettingsClient` (`ws.ts:808-811`, reproduced): the client's settings capabilities. */
const readSettingsClient = (url: URL) => {
  const capabilities = url.searchParams.get(CLIENT_CAPABILITIES_QUERY_PARAM)?.split(',') ?? [];
  return { secretReferences: capabilities.includes(SETTINGS_SECRET_REFERENCES_CAPABILITY) };
};

const platformOs = (): ExecutionEnvironmentDescriptor['platform']['os'] => {
  switch (process.platform) {
    case 'darwin':
      return 'darwin';
    case 'linux':
      return 'linux';
    case 'win32':
      return 'windows';
    default:
      return 'unknown';
  }
};

const platformArch = (): ExecutionEnvironmentDescriptor['platform']['arch'] =>
  process.arch === 'arm64' || process.arch === 'x64' ? process.arch : 'other';

/**
 * What the descriptor says for `serverVersion` on a host that names none: t3's schema needs a
 * value, and t3's client reads it only to show it and to tell one host's builds apart (whether it
 * can talk to a host is the orchestration protocol's to say).
 */
export const GENERIC_SERVER_VERSION = 'unknown';

/**
 * The host as a t3 environment: one per session, so the session id is its environment id (the
 * id a client checks the config against). It advertises no optional capability but the one every
 * protocol-2 server sends: what it does not serve, t3's UI does not offer.
 *
 * Anyone who reaches the port reads it, before any pass (`/.well-known/t3/environment`), so a host
 * bound past loopback (a sandbox's, its port public) names no operating system, architecture or
 * version to scan for: `unknown`, `other` and `GENERIC_SERVER_VERSION`. On loopback, or as a
 * `--dev` host, it names its own. The config a pass holder reads carries the same environment.
 */
export const hostEnvironment = (
  options: Pick<HostServerOptions, 'sessionId' | 'host' | 'dev'>,
): ExecutionEnvironmentDescriptor => {
  const named = options.dev === true || isLoopback(options.host);
  return {
    environmentId: EnvironmentId.make(options.sessionId),
    label: 'Consola host',
    platform: named ? { os: platformOs(), arch: platformArch() } : { os: 'unknown', arch: 'other' },
    serverVersion: named ? T3_SERVER_VERSION : GENERIC_SERVER_VERSION,
    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    capabilities: { repositoryIdentity: false, inlineMessageContext: true },
  };
};

/**
 * t3's `withoutWorkspaceSnapshots` (`ws.ts:484-502`), less its on-demand machine-catalog branches:
 * for a client that fetches each folder's snapshot itself.
 */
const withoutWorkspaceSnapshots = (providers: readonly ServerProvider[]): ServerProvider[] =>
  providers.map(({ workspaceSnapshots: _workspaceSnapshots, ...provider }) => provider);

/**
 * t3's `withProviderStatusDeltas` (`ws.ts:504-525`, reproduced): provider changes as deltas from
 * the list this client last received.
 */
export const withProviderStatusDeltas =
  (sent: readonly ServerProvider[]) =>
  <E, R>(updates: Stream.Stream<ServerConfigStreamEvent, E, R>) =>
    updates.pipe(
      Stream.mapAccum(
        () => sent,
        (
          previous,
          event,
        ): readonly [readonly ServerProvider[], readonly ServerConfigStreamEvent[]] => {
          if (event.type === 'snapshot') return [event.config.providers, [event]];
          if (event.type !== 'providerStatuses') return [previous, [event]];
          const { providers } = event.payload;
          return [
            providers,
            [
              {
                version: 1,
                type: 'providerStatusDeltas',
                payload: { providers: serverProviderDeltas(previous, providers) },
              },
            ],
          ];
        },
      ),
    );

type StreamItem = OrchestrationV2ThreadStreamItem;

/** One connection's handlers: the served methods for the session's thread, and the refusals. */
const layerHandlers = (
  options: HostServerOptions,
  settingsClient: { readonly secretReferences: boolean },
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const { runtime, sessionId } = options;
      const threadId = ThreadId.make(sessionId);
      const { server } = runtime;
      const environment = hostEnvironment(options);

      const loadServerConfig = Effect.fn('host.loadServerConfig')(function* (
        workspaceSnapshotsOnDemand: boolean,
      ) {
        const providers = yield* server.providers.getProviders;
        const settings = redactServerSettingsForClient(yield* server.settings, settingsClient);
        const config: ServerConfig = {
          environment,
          auth: HOST_AUTH,
          cwd: server.cwd,
          keybindingsConfigPath: server.keybindingsConfigPath,
          keybindings: [],
          issues: [],
          providers: workspaceSnapshotsOnDemand ? withoutWorkspaceSnapshots(providers) : providers,
          availableEditors: [],
          observability: {
            logsDirectoryPath: server.logsDir,
            localTracingEnabled: false,
            otlpTracesEnabled: false,
            otlpMetricsEnabled: false,
            otlpLogsEnabled: false,
          },
          settings,
          threadResumeCompletionMarker: true,
          // t3's client opens a thread cold over the socket alone, the first time, from a server
          // that says it pages snapshots (client-runtime `state/threads.ts`, `socketOnly`); a
          // later cold open asks the HTTP route for a bounded one (`hostHttp.ts`). Either way the
          // host's snapshot is the whole thread: a window with no older history to page.
          threadSnapshotPagination: true,
          serverTime: DateTime.formatIso(yield* DateTime.now),
        };
        return config;
      });

      const projectionError = (message: string, cause?: unknown) =>
        new OrchestrationV2GetThreadProjectionError({
          threadId,
          message,
          ...(cause === undefined ? {} : { cause }),
        });

      // t3's `ws.ts` `subscribeOrchestrationV2Thread`, over the session's handle (or, for an agent
      // run, a dispatched agent's thread, read-only): a snapshot and the live events after its
      // sequence, or a replay of what followed a client's cursor.
      const subscribeThread = (input: OrchestrationV2SubscribeThreadInput) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const thread = readableThread(runtime, sessionId, input.threadId);
            if (thread === undefined) {
              return Stream.fail(
                new OrchestrationV2GetThreadProjectionError({
                  threadId: input.threadId,
                  message: `This host serves one thread, not ${input.threadId}.`,
                }),
              );
            }
            const threadId = input.threadId;
            const dedupeBodies = input.acceptDedupedBodies === true;
            // Replay, snapshot and live tail share one deduper: it must see every record sent.
            const withLiveDedupe = <E>(stream: Stream.Stream<StreamItem, E>) =>
              dedupeBodies
                ? Stream.suspend(() => Stream.map(stream, makeLiveBodyDeduper()))
                : stream;
            const eventStreamFrom = (afterSequence: number) =>
              thread.events(afterSequence).pipe(
                Stream.map(threadStreamEventItem),
                coalesceThreadLiveStream,
                Stream.mapError((cause) =>
                  projectionError(
                    `Failed while streaming orchestration V2 thread ${threadId}`,
                    cause,
                  ),
                ),
              );
            const completionMarker: Stream.Stream<StreamItem> =
              input.requestCompletionMarker === true
                ? Stream.make({ kind: 'synchronized' as const })
                : Stream.empty;

            // Always the full projection: the host serves no history pages, so it never answers
            // with t3's bounded window (`acceptBoundedSnapshot` is an offer, not a demand).
            const snapshotThenLive = () => {
              // Read together: `snapshotSequence()` is the last event `snapshot()` holds, so the
              // live events after it continue the snapshot with nothing missed or repeated.
              const snapshotSequence = thread.snapshotSequence();
              const projection = projectThreadProjectionForWire(thread.snapshot());
              const snapshot: StreamItem = {
                kind: 'snapshot',
                snapshotSequence,
                projection: dedupeBodies ? dedupeSnapshotBodies(projection) : projection,
              };
              return rpcInitialItems<StreamItem>([snapshot]).pipe(
                Stream.concat(completionMarker),
                Stream.concat(eventStreamFrom(snapshotSequence)),
                withLiveDedupe,
              );
            };

            if (input.afterSequence === undefined) return snapshotThenLive();
            const afterSequence = input.afterSequence;
            // The thread's high water is the last event its snapshot holds; a cursor past it (a
            // host restarted under the client) gets a snapshot, as in t3.
            const highWater = thread.snapshotSequence();
            if (afterSequence > highWater) return snapshotThenLive();
            const replayed =
              afterSequence === highWater
                ? []
                : Array.from(
                    yield* thread.events(afterSequence).pipe(
                      Stream.takeUntil((stored) => stored.sequence >= highWater),
                      Stream.take(THREAD_RESUME_MAX_REPLAY_EVENTS + 1),
                      Stream.map(threadStreamEventItem),
                      Stream.runCollect,
                      Effect.mapError((cause) =>
                        projectionError(
                          `Failed while replaying orchestration V2 thread ${threadId}`,
                          cause,
                        ),
                      ),
                    ),
                  );
            // A replay that recreates the thread is answered with its snapshot, as in t3.
            if (replayed.some((item) => item.event.type === 'thread.created')) {
              return snapshotThenLive();
            }
            const replay = coalesceLiveUpdatedEvents(replayed);
            const plan = decideThreadResume({
              afterSequence,
              highWater,
              replayEventCount: replay.length,
              replayEncodedBytes: threadReplayEncodedBytes(replay),
            });
            if (plan.mode === 'snapshot') return snapshotThenLive();
            return rpcInitialItems<StreamItem>(replay).pipe(
              Stream.concat(completionMarker),
              Stream.concat(eventStreamFrom(highWater)),
              withLiveDedupe,
            );
          }),
        );

      // t3's `ws.ts` stamps a client command as the person's before it dispatches it.
      const dispatchCommand = (command: OrchestrationV2Command) => {
        const refused = (message: string, cause?: unknown) =>
          new OrchestrationV2DispatchCommandError({
            commandId: command.commandId,
            commandType: command.type,
            message,
            ...(cause === undefined ? {} : { cause }),
          });
        if ('threadId' in command && command.threadId !== threadId) {
          return Effect.fail(refused(`This host runs one thread, not ${command.threadId}.`));
        }
        return runtime
          .dispatch(
            withCreationProvenance(command, {
              createdBy: 'user',
              creationSource: 'creationSource' in command ? command.creationSource : 'web',
            }),
          )
          .pipe(
            Effect.map(({ sequence }) => ({ sequence })),
            Effect.mapError((error) => {
              if (error._tag === 'NotOfferedError') return refused(error.message);
              // As t3's `ws.ts`: the orchestrator's refusal in t3's own words, in `message` and
              // `detail`, or its generic message when it has none.
              const detail = userFacingDispatchErrorMessage(error.cause);
              return new OrchestrationV2DispatchCommandError({
                commandId: command.commandId,
                commandType: command.type,
                message: detail ?? 'Failed to dispatch orchestration V2 command',
                ...(detail === undefined ? {} : { detail }),
                cause: error.cause,
              });
            }),
          );
      };

      const served = ServedRpcGroup.of({
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: subscribeThread,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: dispatchCommand,
        // The session's command rows, or a dispatched agent's (read-only).
        [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: (input) =>
          readableThread(runtime, sessionId, input.threadId)?.commandOutput(input.itemId) ??
          Stream.fail(
            new OrchestrationV2CommandOutputError({
              threadId: input.threadId,
              message: `This host serves one thread, not ${input.threadId}.`,
            }),
          ),
        // t3's `ws.ts` `subscribeOrchestrationV2Shell`, for the session's thread alone.
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) => subscribeHostShell(runtime, input),
        [WS_METHODS.serverProbe]: () => Effect.succeed({}),
        // t3's `ws.ts` handler, less what the host does not compose: keybindings, environment
        // themes, usage-limit sources, network discovery and on-demand machine catalogs.
        [WS_METHODS.subscribeServerConfig]: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const workspaceSnapshotsOnDemand = input.workspaceSnapshotsOnDemand === true;
              // Subscribed before the snapshot is read, so no change in between is lost.
              const settingsChanges = yield* server.settingsChanges;
              const config = yield* loadServerConfig(workspaceSnapshotsOnDemand);
              const providerStatuses = Stream.concat(
                Stream.fromEffect(server.providers.getProviders),
                server.providers.streamChanges,
              ).pipe(
                Stream.map((providers) =>
                  workspaceSnapshotsOnDemand ? withoutWorkspaceSnapshots(providers) : providers,
                ),
                // Compared with the snapshot's list first, so only a change is sent.
                (updates) => Stream.concat(rpcInitialItems([config.providers]), updates),
                Stream.changesWith(
                  (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
                ),
                Stream.drop(1),
                Stream.map(
                  (providers): ServerConfigStreamEvent => ({
                    version: 1,
                    type: 'providerStatuses',
                    payload: { providers },
                  }),
                ),
                Stream.debounce(PROVIDER_STATUS_DEBOUNCE),
              );
              const settingsUpdates = settingsChanges.pipe(
                Stream.map(
                  (settings): ServerConfigStreamEvent => ({
                    version: 1,
                    type: 'settingsUpdated',
                    payload: { settings: redactServerSettingsForClient(settings, settingsClient) },
                  }),
                ),
              );
              const updates = Stream.merge(providerStatuses, settingsUpdates);
              const snapshot: ServerConfigStreamEvent = { version: 1, type: 'snapshot', config };
              return Stream.concat(
                rpcInitialItems([snapshot]),
                input.providerStatusDeltas === true
                  ? updates.pipe(withProviderStatusDeltas(config.providers))
                  : updates,
              );
            }),
          ),
        // t3's `ws.ts` handler over t3's provider registry, less usage-limit sources, a model
        // refresh per instance and on-demand machine catalogs. A folder snapshot is only ever
        // the session's own folder's.
        [WS_METHODS.serverRefreshProviders]: (input) =>
          Effect.gen(function* () {
            const registry = server.providers;
            if (input.modelCatalogOnly === true) {
              yield* registry.refreshModelCatalog;
              return { providers: [] };
            }
            const { instanceId, cwd } = input;
            if (instanceId !== undefined && cwd !== undefined && cwd !== server.cwd) {
              return yield* new ProviderSetupError({
                instanceId,
                operation: 'refresh',
                detail: 'This host scans only its session’s folder.',
              });
            }
            if (input.refreshModels === true) {
              yield* registry.invalidateModelCaches({ instanceId, cwd, fresh: input.fresh });
            }
            const providers = yield* instanceId !== undefined && cwd !== undefined
              ? registry.refreshWorkspaceSnapshot({ instanceId, cwd, fresh: input.fresh === true })
              : input.reloadSecrets === true
                ? registry.reloadSecretsAndRefresh(instanceId)
                : instanceId !== undefined
                  ? registry.refreshInstance(instanceId)
                  : registry.refresh();
            if (input.omitProviders === true && (instanceId === undefined || cwd === undefined)) {
              return { providers: [] };
            }
            if (input.workspaceSnapshotsOnDemand !== true) return { providers };
            if (instanceId === undefined || cwd === undefined) {
              return { providers: withoutWorkspaceSnapshots(providers) };
            }
            // Callers read only the folder's snapshot; the config stream carries the rest.
            return {
              providers: providers
                .filter((provider) => provider.instanceId === instanceId)
                .map((provider) => ({
                  ...provider,
                  models: [],
                  slashCommands: [],
                  skills: [],
                  workspaceSnapshots: (provider.workspaceSnapshots ?? []).filter(
                    (snapshot) => snapshot.cwd === cwd,
                  ),
                })),
            };
          }),
      });
      const refusals = Object.fromEntries(
        otherRpcs.map((rpc) => [rpc._tag, notOffered(rpc)]),
      ) as unknown as RpcGroup.HandlersFrom<Rpc.Any>;
      const refused = yield* OtherRpcGroup.toHandlers(refusals);
      return Context.merge(
        yield* ServedRpcGroup.toHandlers(served),
        refused as Context.Context<Rpc.ToHandler<OtherRpc>>,
      );
    }),
  );

/** The pass already let the connection in: every method's scope check passes. */
const layerAuthorization = Layer.succeed(RpcScopeAuthorization)((effect) => effect);

/**
 * t3's `hasCompatibleOrchestrationProtocol` (`ws.ts:801-806`, reproduced): the client must speak
 * the orchestration protocol this server does. Its 426 answer is t3's (`ws.ts:3704-3711`).
 */
const hasCompatibleOrchestrationProtocol = (url: URL) =>
  url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) ===
  String(ORCHESTRATION_PROTOCOL_VERSION);

/**
 * Refuses a connection: a WebSocket is upgraded and closed with `4401`, so a browser can read why
 * (it sees no HTTP status); anything else gets a `401`.
 */
const refuseConnection = Effect.fn('host.refuseConnection')(
  function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const upgraded = yield* Effect.exit(request.upgrade);
    if (Exit.isFailure(upgraded)) return HttpServerResponse.empty({ status: 401 });
    const reader = yield* upgraded.value.reader;
    const writer = yield* upgraded.value.writer;
    yield* writer.write(new Socket.CloseEvent(4401, TICKET_REFUSED_REASON));
    // The close handshake ends when the client's close frame ends the reader.
    yield* Effect.forever(reader.pull).pipe(
      Effect.ignore,
      Effect.timeoutOption(CLOSE_HANDSHAKE_TIMEOUT),
    );
    return HttpServerResponse.empty();
  },
  Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty())),
  Effect.scoped,
);

/**
 * One connection's RPC server, as t3's `ws.ts` runs one per socket. The pass that let it in
 * bounds it: at the pass's `exp` (`expiresAtSeconds`) the socket is closed with `4401`, as a
 * connection with that pass would be refused then; a socket that closes first cancels it.
 */
const serveRpc = Effect.fn('host.serveRpc')(function* (
  options: HostServerOptions,
  url: URL,
  expiresAtSeconds: number,
) {
  const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
  yield* RpcServer.make(WsRpcGroup, WS_RPC_SERVER_OPTIONS).pipe(
    Effect.provideService(RpcServer.Protocol, withOutputWindow(protocol)),
    Effect.provide(
      Layer.merge(layerHandlers(options, readSettingsClient(url)), layerAuthorization),
    ),
    Effect.forkScoped,
  );
  // A client that asks for frame parts gets large frames split, as t3's server sends them
  // (`ws.ts:3814-3827`).
  const frameParts = url.searchParams.has(SOCKET_FRAME_PARTS_QUERY_PARAM);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const upgraded = yield* Deferred.make<Socket.Socket>();
  // Forked in the connection's scope, which closes when its socket does.
  yield* Effect.gen(function* () {
    const socket = yield* Deferred.await(upgraded);
    const nowMs = yield* Clock.currentTimeMillis;
    yield* Effect.sleep(Duration.millis(Math.max(0, expiresAtSeconds * 1000 - nowMs)));
    const writer = yield* socket.writer;
    yield* writer.write(new Socket.CloseEvent(4401, PASS_EXPIRED_REASON));
  }).pipe(Effect.scoped, Effect.ignore, Effect.forkScoped);
  return yield* httpEffect.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      Object.create(request, {
        upgrade: {
          value: request.upgrade.pipe(
            Effect.map((socket) => (frameParts ? splitLargeSocketFrames(socket) : socket)),
            Effect.tap((socket) => Deferred.succeed(upgraded, socket)),
          ),
        },
      }),
    ),
  );
}, Effect.provide(RpcSerialization.layerJson));

/**
 * Every request: `GET /ws` with a ticket the host issued becomes an RPC connection; the ticket is
 * taken before anything else is answered. The calls t3's client makes before the socket (the
 * descriptor, a ticket for its pass, the session) are `hostHttp.ts`'s, where the pass is
 * verified; neither is ever logged.
 */
const app = Effect.fn('host.app')(function* (
  options: HostServerOptions,
  key: PassKey,
  tickets: SocketTickets,
  connections: { open: number },
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // A request line no URL can be made of (`GET http://[ HTTP/1.1`) is the client's error.
  const url = URL.parse(request.url, 'http://consola-host.invalid');
  if (url === null) return HttpServerResponse.empty({ status: 400 });
  const lifetime: PassLifetime = options.dev === true ? 'dev' : 'cell';
  const verify = (pass: string) =>
    Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
      verifyPassWith(pass, key, options.sessionId, Math.floor(nowMs / 1000), lifetime),
    );
  // An agent run's tools, for its threads' CLIs alone: a thread's token, never a pass, and no
  // CORS (`mcpHttp.ts`). Every other session has no `/mcp`: it is the `404` below.
  const agentRun = options.runtime.agentRun;
  if (url.pathname === MCP_PATH && agentRun !== null) return yield* serveMcp(agentRun);
  // A person's follow-up for an agent run's orchestrator, from the cell: a pass, and no CORS
  // (`followUpHttp.ts`). Every other session has no such path: it is the `404` below.
  if (url.pathname === FOLLOW_UP_PATH && agentRun !== null) {
    return yield* serveFollowUp(agentRun, verify, options.sessionId);
  }
  // Everything but the socket: t3's calls before it, and a CORS-readable `404` for the rest.
  if (url.pathname !== WS_PATH) {
    return yield* serveHostHttp(
      {
        environment: hostEnvironment(options),
        auth: HOST_AUTH,
        verify,
        issueTicket: (claims) =>
          Effect.map(Clock.currentTimeMillis, (nowMs) => tickets.issue(claims.exp, nowMs)),
        runtime: options.runtime,
      },
      url,
    );
  }
  if (request.method !== 'GET') return HttpServerResponse.empty({ status: 404 });
  // The socket opens with a ticket alone, used once (`socketTickets.ts`); never with a pass.
  const redeemed = tickets.redeem(
    url.searchParams.get(WS_TICKET_QUERY_PARAM) ?? '',
    yield* Clock.currentTimeMillis,
  );
  if (redeemed === null) return yield* refuseConnection();
  return yield* hasCompatibleOrchestrationProtocol(url)
    ? // A connection counts from the moment it is let in until its socket closes.
      Effect.acquireUseRelease(
        Effect.sync(() => {
          connections.open += 1;
        }),
        () => serveRpc(options, url, redeemed.passExpiresAtSeconds),
        () =>
          Effect.sync(() => {
            connections.open -= 1;
          }),
      )
    : Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          {
            code: 'orchestration_protocol_incompatible',
            message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          },
          { status: 426 },
        ),
      );
});

/**
 * Serves one session's thread at `ws://<host>:<port>/ws` in the caller's scope, and answers the
 * port it listens on (the one asked for, or the ephemeral one `0` got) and its count of connected
 * clients. Closing the scope stops the server and its connections. Fails with `PassKeyInvalid`
 * when `publicKeyPem` is not an Ed25519 public key, and with `HostListenError` when it cannot
 * listen.
 */
export const listenHost = (
  options: HostServerOptions,
): Effect.Effect<HostListening, HostListenError | PassKeyInvalid, Scope.Scope> =>
  Effect.gen(function* () {
    // A dev host's long pass never reaches a public address (`bin.ts` refuses the flags first).
    if (options.dev === true && !isLoopback(options.host)) {
      return yield* Effect.die(
        new Error(`A --dev host listens only on loopback, not on ${options.host}.`),
      );
    }
    // The key is parsed once, before the port is bound: a key that does not parse fails the
    // start, rather than refusing every pass as it arrives.
    const key = yield* parsePassKey(options.publicKeyPem);
    const server = yield* NodeHttpServer.make(() => createServer(), {
      port: options.port,
      host: options.host,
      // The server makes its `ws` WebSocketServer at the first upgrade and closes it with the
      // scope; with client tracking (ws's default) that close waits for every socket to end,
      // and it runs before the server's own finalizer closes them, so closing a scope with a
      // connected client would hang. The server tracks its sockets itself (`upgradedWebSockets`).
      websocket: { clientTracking: false },
    }).pipe(Effect.mapError((cause) => new HostListenError({ cause })));
    const connections = { open: 0 };
    const tickets = makeSocketTickets();
    // No request span: one would record the request's URL, and the socket's ticket travels in
    // it (`wsTicket`). Every request runs with the ticket, and the pass a client might still put
    // there (refused), among the redacted query parameters, so nothing that shows a URL shows
    // either.
    yield* server.serve(app(options, key, tickets, connections)).pipe(
      Effect.provideService(HttpMiddleware.TracerDisabledWhen, () => true),
      Effect.provideService(UrlParams.CurrentRedactedNames, HOST_REDACTED_URL_PARAMS),
    );
    const address = server.address;
    const listening: HostListening = {
      port: address._tag === 'UnixPathAddress' ? options.port : address.port,
      connectedClients: () => connections.open,
    };
    return listening;
  });

/** `listenHost`, serving until the scope closes. */
export const serveHost = (
  options: HostServerOptions,
): Effect.Effect<never, HostListenError | PassKeyInvalid, Scope.Scope> =>
  listenHost(options).pipe(Effect.andThen(Effect.never));
