import type { WsRpcProtocolClient } from '@t3tools/client-runtime/rpc';
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ServerConfig,
  WS_METHODS,
  WsRpcGroup,
} from '@t3tools/contracts';
import {
  joinSocketFrameParts,
  SOCKET_FRAME_PARTS_QUERY_PARAM,
} from '@t3tools/shared/socketFrameParts';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
import * as Stream from 'effect/Stream';
import { RpcClient, RpcSerialization } from 'effect/rpc';
import * as Socket from 'effect/socket/Socket';

/**
 * The socket URL t3's client opens for a host on this machine: `/ws` (`connection/resolver.ts`),
 * t3's orchestration protocol (`connection/compatibility.ts`), the frame-parts flag
 * (`rpc/session.ts`) and, when given, the session's pass.
 */
export const hostSocketUrl = (port: number, pass?: string): string => {
  const url = new URL(`ws://127.0.0.1:${port}/ws`);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set(SOCKET_FRAME_PARTS_QUERY_PARAM, '1');
  if (pass !== undefined) url.searchParams.set('pass', pass);
  return url.toString();
};

/** A client connected to a host, and the first config snapshot it was sent. */
export type T3Client = {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: ServerConfig;
};

/**
 * t3's own RPC client, connected the way `@t3tools/client-runtime` connects it: its protocol client
 * (`rpc/protocol.ts`, `RpcClient.make(WsRpcGroup)`) over the socket `rpc/session.ts` opens (JSON
 * serialization, frame parts joined, no retries), and ready, as `rpc/session.ts` holds it, once
 * the config subscription's first snapshot arrives. client-runtime's package exports name its
 * session factory nowhere, so it is rebuilt here from the same calls.
 */
export const connectT3Client = Effect.fn('connectT3Client')(function* (url: string) {
  const layerSocket = Layer.effect(
    Socket.Socket,
    Effect.map(Effect.service(Socket.Socket), joinSocketFrameParts),
  ).pipe(
    Layer.provide(Socket.layerWebSocket(url, { openTimeout: '15 seconds' })),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  const layerProtocol = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      pingTimeout: '15 seconds',
      retryTransientErrors: false,
      retryPolicy: Schedule.recurs(0),
    }),
  ).pipe(Layer.provide(Layer.mergeAll(layerSocket, RpcSerialization.layerJson)));
  const context = yield* Layer.build(layerProtocol);
  const client: WsRpcProtocolClient = yield* RpcClient.make(WsRpcGroup).pipe(
    Effect.provideContext(context),
  );
  // client-runtime's session subscribes with on-demand workspace snapshots and waits for the
  // first `snapshot` before it counts as ready.
  const first = yield* client[WS_METHODS.subscribeServerConfig]({
    workspaceSnapshotsOnDemand: true,
  }).pipe(
    Stream.filter((event) => event.type === 'snapshot'),
    Stream.runHead,
  );
  if (Option.isNone(first) || first.value.type !== 'snapshot') {
    return yield* Effect.die(new Error('The host sent no config snapshot.'));
  }
  const connected: T3Client = { client, initialConfig: first.value.config };
  return connected;
});
