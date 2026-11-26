// @effect-diagnostics nodeBuiltinImport:off - Tokens are random bytes, compared by their hashes in constant time.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EnvironmentId } from '@t3tools/contracts';
import type { ThreadId } from '@t3tools/contracts';
import * as McpProviderSessions from '@t3tools/provider-core/server/McpProviderSessions';
import * as Clock from 'effect/Clock';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type * as McpInvocationContext from 't3/mcp/McpInvocationContext.ts';
import * as McpSessionRegistry from 't3/mcp/McpSessionRegistry.ts';

/** The path the host serves an agent run's tools at, on its own port (`adapters/mcpHttp.ts`). */
export const MCP_PATH = '/mcp';

/**
 * An agent run's MCP credentials: t3's `McpSessionRegistry`, standing in for t3's own (which needs
 * t3's HTTP server), so every provider session of the run's threads gets t3's `t3-code` MCP server
 * at `http://127.0.0.1:<the host's port>/mcp` with a bearer token of its own, and the `/mcp`
 * endpoint learns from a token which thread is calling. Tokens live in memory only, are never
 * logged, and are compared by their SHA-256 in constant time.
 */
export type AgentRunMcp = {
  /** t3's `McpSessionRegistry` and its real `McpProviderSessions`, for the run's orchestration. */
  readonly layer: Layer.Layer<
    McpSessionRegistry.McpSessionRegistry | McpProviderSessions.McpProviderSessions
  >;
  /** The port `/mcp` is served on, once the host listens: every credential waits for it. */
  readonly setPort: (port: number) => Effect.Effect<void>;
  /** The thread a bearer token was issued to, or null for none (no token, or a wrong one). */
  readonly threadForToken: (token: string) => ThreadId | null;
};

type Credential = {
  readonly tokenHash: Buffer;
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
};

const hashOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/**
 * The capabilities a credential's config tells the adapter about: `orchestration` alone, so no
 * adapter adds t3's browser or device instructions for tools this server does not have.
 */
const SERVED_CAPABILITIES: ReadonlySet<string> = new Set(['orchestration']);

export const makeAgentRunMcp = Effect.gen(function* () {
  const port = yield* Deferred.make<number>();
  const environmentId = EnvironmentId.make('environment:consola-host');
  let credentials: readonly Credential[] = [];
  const revokeWhere = (drop: (credential: Credential) => boolean) =>
    Effect.sync(() => {
      credentials = credentials.filter((credential) => !drop(credential));
    });

  const threadForToken = (token: string): ThreadId | null => {
    if (token === '') return null;
    const presented = hashOf(token);
    let found: ThreadId | null = null;
    // Every credential is compared, so the time says nothing of which one matched.
    for (const credential of credentials) {
      if (timingSafeEqual(presented, credential.tokenHash)) {
        found = credential.scope.thread.threadId;
      }
    }
    return found;
  };

  const registry = McpSessionRegistry.McpSessionRegistry.of({
    issue: Effect.fn('AgentRunMcp.issue')(function* (request) {
      const listening = yield* Deferred.await(port);
      const token = randomBytes(32).toString('base64url');
      const providerSessionId = randomUUID();
      // What was asked, so t3's check of a live credential (`ProviderSessionManager`) finds it
      // unchanged and keeps it, rather than revoking a token a running CLI still holds.
      const capabilities = new Set<McpInvocationContext.McpCapability>([
        'orchestration',
        ...(request.capabilities ?? []),
      ]);
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: providerSessionId,
        thread: {
          threadId: request.threadId,
          providerSessionId,
          providerInstanceId: request.providerInstanceId,
          subagent: request.subagent === true,
        },
        client: undefined,
        capabilities,
        issuedAt: yield* Clock.currentTimeMillis,
      };
      credentials = [...credentials, { tokenHash: hashOf(token), scope }];
      return {
        config: {
          environmentId,
          threadId: request.threadId,
          providerSessionId,
          providerInstanceId: request.providerInstanceId,
          endpoint: `http://127.0.0.1:${listening}${MCP_PATH}`,
          authorizationHeader: `Bearer ${token}`,
          browserToolsAvailable: false,
          capabilities: SERVED_CAPABILITIES,
        },
      };
    }),
    resolve: Effect.fn('AgentRunMcp.resolve')((token) => {
      if (token === '') return Effect.undefined;
      const presented = hashOf(token);
      let scope: McpInvocationContext.McpThreadInvocationScope | undefined;
      for (const credential of credentials) {
        if (timingSafeEqual(presented, credential.tokenHash)) scope = credential.scope;
      }
      return Effect.succeed(scope);
    }),
    touch: Effect.fn('AgentRunMcp.touch')(() => Effect.void),
    revokeProviderSession: Effect.fn('AgentRunMcp.revokeProviderSession')((providerSessionId) =>
      revokeWhere((credential) => credential.scope.thread.providerSessionId === providerSessionId),
    ),
    revokeThread: Effect.fn('AgentRunMcp.revokeThread')((threadId) =>
      revokeWhere((credential) => credential.scope.thread.threadId === threadId),
    ),
    revokeAll: revokeWhere(() => true),
  });

  const mcp: AgentRunMcp = {
    layer: Layer.merge(
      Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry),
      McpProviderSessions.layer,
    ),
    setPort: (listening) => Deferred.succeed(port, listening).pipe(Effect.asVoid),
    threadForToken,
  };
  return mcp;
});
