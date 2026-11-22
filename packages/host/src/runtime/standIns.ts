import { EnvironmentId, TerminalNotRunningError } from '@t3tools/contracts';
import * as McpProviderSessions from '@t3tools/provider-core/server/McpProviderSessions';
import * as SecureRandom from 'effect/crypto/SecureRandom';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Ref from 'effect/Ref';
import * as Stream from 'effect/Stream';
import * as ServerSecretStore from 't3/auth/ServerSecretStore.ts';
import * as McpSessionRegistry from 't3/mcp/McpSessionRegistry.ts';
import * as TerminalManager from 't3/terminal/Manager.ts';

/**
 * The services of t3's server that need what only its HTTP server or its own login store
 * provides, standing in for them in a host. Each is the smallest version that keeps the
 * services built on it working; `packages/host/AGENTS.md` lists why each exists.
 */

const NEVER_STORED = 'The Consola host never stores credentials; a CLI keeps its own login.';

/**
 * t3's server secret store keeps logins and API keys on disk (`secretsDir`). The host keeps none:
 * reading a secret finds nothing, and writing, creating or removing one fails. The random values
 * t3 makes for itself (`getOrCreateRandom`: an environment id, a signing key) live in memory only.
 */
export const layerSecretStore = Layer.effect(
  ServerSecretStore.ServerSecretStore,
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const generated = yield* Ref.make(new Map<string, Uint8Array>());
    const refuse = (resource: string) =>
      new ServerSecretStore.SecretStorePersistError({ resource, cause: NEVER_STORED });
    return ServerSecretStore.ServerSecretStore.of({
      get: Effect.fn('HostSecretStore.get')((name) =>
        Ref.get(generated).pipe(Effect.map((values) => Option.fromUndefinedOr(values.get(name)))),
      ),
      set: Effect.fn('HostSecretStore.set')((name) => Effect.fail(refuse(name))),
      create: Effect.fn('HostSecretStore.create')((name) => Effect.fail(refuse(name))),
      remove: Effect.fn('HostSecretStore.remove')((name) => Effect.fail(refuse(name))),
      getOrCreateRandom: Effect.fn('HostSecretStore.getOrCreateRandom')(function* (name, bytes) {
        const existing = (yield* Ref.get(generated)).get(name);
        if (existing !== undefined) return existing;
        const value = yield* random.randomBytes(bytes);
        yield* Ref.update(generated, (values) => new Map(values).set(name, value));
        return value;
      }),
    });
  }),
);

/**
 * t3 gives each provider session an MCP server of its own tools, served by its HTTP server
 * (`McpHttpServer`, `McpSessionRegistry.layer` needs `HttpServer`). The host has no such server,
 * so it issues credentials nothing reads and records no provider MCP session: an adapter finds
 * none, and starts its CLI without t3's MCP server.
 */
export const layerMcp = Layer.mergeAll(
  Layer.succeed(
    McpSessionRegistry.McpSessionRegistry,
    McpSessionRegistry.McpSessionRegistry.of({
      issue: Effect.fn('HostMcpSessionRegistry.issue')(({ threadId, providerInstanceId }) =>
        Effect.succeed({
          config: {
            environmentId: EnvironmentId.make('environment:consola-host'),
            threadId,
            providerSessionId: `consola-host:${threadId}`,
            providerInstanceId,
            endpoint: 'about:blank',
            authorizationHeader: '',
            browserToolsAvailable: false,
          },
        }),
      ),
      resolve: Effect.fn('HostMcpSessionRegistry.resolve')(() => Effect.undefined),
      touch: Effect.fn('HostMcpSessionRegistry.touch')(() => Effect.void),
      revokeProviderSession: Effect.fn('HostMcpSessionRegistry.revokeProviderSession')(
        () => Effect.void,
      ),
      revokeThread: Effect.fn('HostMcpSessionRegistry.revokeThread')(() => Effect.void),
      revokeAll: Effect.void,
    }),
  ),
  Layer.effect(
    McpProviderSessions.McpProviderSessions,
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      return McpProviderSessions.McpProviderSessions.of({
        ...sessions,
        set: Effect.fn('HostMcpProviderSessions.set')(() => Effect.void),
        read: Effect.fn('HostMcpProviderSessions.read')(() => Effect.undefined),
      });
    }),
  ).pipe(Layer.provide(McpProviderSessions.layer)),
);

const notRunning = (input: { readonly threadId: string; readonly terminalId?: string }) =>
  new TerminalNotRunningError({ threadId: input.threadId, terminalId: input.terminalId ?? '' });

/**
 * t3's terminals are PTYs (`node-pty`), which the host does not carry: its CLI runs through the
 * provider adapter, never in a terminal, and it runs no project setup script (its project has
 * none). Opening, reading or writing a terminal fails as one that is not running; nothing ever
 * runs, so closing and subscribing do nothing.
 */
export const layerTerminals = Layer.succeed(
  TerminalManager.TerminalManager,
  TerminalManager.TerminalManager.of({
    open: Effect.fn('HostTerminals.open')((input) => Effect.fail(notRunning(input))),
    getShell: Effect.fn('HostTerminals.getShell')((input) => Effect.fail(notRunning(input))),
    attachStream: Effect.fn('HostTerminals.attachStream')((input) =>
      Effect.fail(notRunning(input)),
    ),
    attachOutputStream: (input) => Stream.fail(notRunning(input)),
    observeStream: Effect.fn('HostTerminals.observeStream')((input) =>
      Effect.fail(notRunning(input)),
    ),
    resyncStream: Effect.fn('HostTerminals.resyncStream')((input) =>
      Effect.fail(notRunning(input)),
    ),
    write: Effect.fn('HostTerminals.write')((input) => Effect.fail(notRunning(input))),
    resize: Effect.fn('HostTerminals.resize')((input) => Effect.fail(notRunning(input))),
    clear: Effect.fn('HostTerminals.clear')((input) => Effect.fail(notRunning(input))),
    close: Effect.fn('HostTerminals.close')(() => Effect.void),
    closeOnSettle: Effect.fn('HostTerminals.closeOnSettle')(() => Effect.void),
    closeIdle: Effect.fn('HostTerminals.closeIdle')(() => Effect.void),
    hasActiveSubprocess: Effect.fn('HostTerminals.hasActiveSubprocess')(() =>
      Effect.succeed(false),
    ),
    subscribe: Effect.fn('HostTerminals.subscribe')(() => Effect.succeed(() => {})),
    subscribeMetadata: Effect.fn('HostTerminals.subscribeMetadata')(() => Effect.succeed(() => {})),
  }),
);
