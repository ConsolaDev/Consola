// @effect-diagnostics nodeBuiltinImport:off - A ticket is asked for over node:http, which no test's fetch stub reaches.
import { request } from 'node:http';
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
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { RpcClient, RpcSerialization } from 'effect/rpc';
import * as Socket from 'effect/socket/Socket';

/**
 * The socket URL t3's client opens for a host on this machine: `/ws` (`connection/resolver.ts`),
 * t3's orchestration protocol (`connection/compatibility.ts`), the frame-parts flag
 * (`rpc/session.ts`) and, when given, the socket ticket it was issued (`wsTicket`,
 * `authorization/remote.ts`).
 */
export const hostSocketUrl = (port: number, ticket?: string): string => {
  const url = new URL(`ws://127.0.0.1:${port}/ws`);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set(SOCKET_FRAME_PARTS_QUERY_PARAM, '1');
  if (ticket !== undefined) url.searchParams.set('wsTicket', ticket);
  return url.toString();
};

/** What a host on this machine answered a ticket request: its status and body. */
export type TicketAnswer = { readonly status: number; readonly body: string };

/**
 * Asks a host on this machine for a socket ticket as t3's client asks
 * (`issueRemoteWebSocketTicket`, `use` `rpc`): `POST /api/auth/websocket-ticket/rpc` with
 * `Authorization: Bearer <pass>`.
 */
export const askHostTicket = (port: number, pass: string): Effect.Effect<TicketAnswer> =>
  Effect.callback<TicketAnswer>((resume) => {
    const asked = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/auth/websocket-ticket/rpc',
        headers: { authorization: `Bearer ${pass}` },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resume(Effect.succeed({ status: response.statusCode ?? 0, body })),
        );
      },
    );
    asked.on('error', (error) => resume(Effect.die(error)));
    asked.end();
  });

const decodeIssued = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ ticket: Schema.String })),
);

/** A socket ticket for `pass` from a host on this machine; dies when it issues none. */
export const issueHostTicket = (port: number, pass: string): Effect.Effect<string> =>
  askHostTicket(port, pass).pipe(
    Effect.flatMap(({ status, body }) =>
      status === 200
        ? decodeIssued(body).pipe(Effect.map(({ ticket }) => ticket))
        : Effect.die(new Error(`The host issued no ticket (${status}).`)),
    ),
    Effect.orDie,
  );

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

/**
 * t3's client connected to a host on this machine with `pass`, as client-runtime connects with a
 * bearer token: a ticket for the pass, then the socket that ticket opens.
 */
export const connectHost = (port: number, pass: string) =>
  issueHostTicket(port, pass).pipe(
    Effect.flatMap((ticket) => connectT3Client(hostSocketUrl(port, ticket))),
  );
