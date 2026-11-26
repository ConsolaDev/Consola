// @effect-diagnostics nodeBuiltinImport:off - An attempt's key pair is a node:crypto key pair.
/**
 * The runner as the only client of an agent step's host: the host in the step's sandbox checks
 * every pass against the public key the runner gave the sandbox, so the runner makes a key pair
 * per attempt (`makeStepKeys`), keeps the private key in memory, and signs its own passes with
 * the protocol's claims (`passClaims`), as the cell's `passSigner` signs a person's. A pass lives
 * at most `PASS_MAX_LIFETIME_SECONDS`; a new one is signed before the old runs out.
 *
 * It talks to the host as t3's client does: the thread is read over HTTP (Effect's `HttpClient`), as one bounded snapshot
 * (`GET /api/orchestration/threads/<id>/bounded`, with the pass as the bearer token), and each
 * command goes over a socket of its own, opened with a ticket for the pass, as
 * `@t3tools/client-runtime` opens one (`testing/t3Client.ts` does the same for the tests), then
 * closed. A socket the host would close at the pass's end is never held, so a long turn needs no
 * reconnection.
 */
import { generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { PASS_MAX_LIFETIME_SECONDS, PASS_TYPE, passClaims } from '@consola/runner-protocol';
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadBoundedSnapshot,
  WsRpcGroup,
} from '@t3tools/contracts';
import type { OrchestrationV2Command, OrchestrationV2ThreadProjection } from '@t3tools/contracts';
import {
  joinSocketFrameParts,
  SOCKET_FRAME_PARTS_QUERY_PARAM,
} from '@t3tools/shared/socketFrameParts';
import * as Clock from 'effect/Clock';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import { RpcClient, RpcSerialization } from 'effect/rpc';
import * as Socket from 'effect/socket/Socket';
import { SignJWT } from 'jose';
import { STEP_PASS_SUBJECT, STEP_PASS_WORKSPACE } from '../core/steps/stepSandbox.ts';

/** A call to the step's host failed; `problem` says which, never a pass or a ticket. */
export class StepHostFailed extends Schema.TaggedError<StepHostFailed>()('StepHostFailed', {
  problem: Schema.String,
}) {
  override get message(): string {
    return this.problem;
  }
}

/** An attempt's key pair: the public key goes to the sandbox, the private key stays here. */
export type StepKeys = { readonly publicKeyPem: string; readonly privateKey: KeyObject };

export const makeStepKeys = (): StepKeys => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
};

/** A new pass is signed once the one held has less than this left, in seconds. */
const PASS_RENEW_MARGIN_SECONDS = 60;

/** How long one HTTP call to the host may take. */
const HTTP_TIMEOUT = Duration.seconds(30);

export type StepHostClient = {
  /** The thread as it is now. */
  readonly snapshot: Effect.Effect<OrchestrationV2ThreadProjection, StepHostFailed>;
  /** Sends one command over a socket of its own, and returns once the host has taken it. */
  readonly dispatch: (command: OrchestrationV2Command) => Effect.Effect<void, StepHostFailed>;
};

const decodeBounded = Schema.decodeUnknownEffect(OrchestrationV2ThreadBoundedSnapshot);
const decodeTicket = Schema.decodeUnknownEffect(Schema.Struct({ ticket: Schema.String }));

/** The socket's address for a host at `hostUrl` (`http:` → `ws:`, `https:` → `wss:`), with its ticket. */
export const stepSocketUrl = (hostUrl: string, ticket: string): string => {
  const url = new URL('/ws', hostUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set(SOCKET_FRAME_PARTS_QUERY_PARAM, '1');
  url.searchParams.set('wsTicket', ticket);
  return url.toString();
};

/**
 * A client of the step's host at `hostUrl` (an origin `exposePort` gave), for the thread
 * `sessionId`, signing its passes with `keys`.
 */
export const makeStepHostClient = (options: {
  readonly hostUrl: string;
  readonly sessionId: string;
  readonly keys: StepKeys;
}): StepHostClient => {
  let held: { readonly pass: string; readonly exp: number } | null = null;
  const fail = (problem: string) => new StepHostFailed({ problem });

  const pass = Effect.gen(function* () {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    if (held !== null && held.exp - now > PASS_RENEW_MARGIN_SECONDS) return held.pass;
    const claims = passClaims({
      personId: STEP_PASS_SUBJECT,
      workspaceId: STEP_PASS_WORKSPACE,
      sessionId: options.sessionId,
      issuedAt: now,
      lifetimeSeconds: PASS_MAX_LIFETIME_SECONDS,
    });
    const signed = yield* Effect.tryPromise({
      try: () =>
        new SignJWT({ ...claims })
          .setProtectedHeader({ alg: 'EdDSA', typ: PASS_TYPE })
          .sign(options.keys.privateKey),
      catch: () => fail('The runner could not sign a pass for the step.'),
    });
    held = { pass: signed, exp: claims.exp };
    return signed;
  });

  /** One HTTP call to the host with a pass, answering its body read as JSON. */
  const call = Effect.fn('StepHostClient.call')(function* (
    path: string,
    method: 'GET' | 'POST',
    what: string,
  ) {
    const bearer = yield* pass;
    const url = new URL(path, options.hostUrl).toString();
    const request = (
      method === 'GET' ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
    ).pipe(
      HttpClientRequest.bearerToken(bearer),
      HttpClientRequest.setHeader(
        ORCHESTRATION_PROTOCOL_HEADER,
        ORCHESTRATION_PROTOCOL_VERSION_TEXT,
      ),
    );
    const response = yield* HttpClient.execute(request).pipe(
      Effect.timeout(HTTP_TIMEOUT),
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError(() => fail(`The step's host did not answer ${what}.`)),
    );
    if (response.status !== 200) {
      return yield* fail(`The step's host answered ${what} with ${response.status}.`);
    }
    return yield* response.json.pipe(
      Effect.mapError(() => fail(`The step's host answered ${what} with no JSON.`)),
    );
  });

  const snapshot = Effect.gen(function* () {
    const json = yield* call(
      `/api/orchestration/threads/${encodeURIComponent(options.sessionId)}/bounded`,
      'GET',
      "the thread's read",
    );
    const bounded = yield* decodeBounded(json).pipe(
      Effect.mapError(() => fail("The step's host sent a thread the runner cannot read.")),
    );
    return bounded.projection;
  });

  const dispatch = Effect.fn('StepHostClient.dispatch')(function* (
    command: OrchestrationV2Command,
  ) {
    const json = yield* call('/api/auth/websocket-ticket/rpc', 'POST', 'a ticket request');
    const { ticket } = yield* decodeTicket(json).pipe(
      Effect.mapError(() => fail("The step's host sent no ticket.")),
    );
    const layerSocket = Layer.effect(
      Socket.Socket,
      Effect.map(Effect.service(Socket.Socket), joinSocketFrameParts),
    ).pipe(
      Layer.provide(
        Socket.layerWebSocket(stepSocketUrl(options.hostUrl, ticket), {
          openTimeout: '15 seconds',
        }),
      ),
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
    yield* Effect.gen(function* () {
      const context = yield* Layer.build(layerProtocol);
      const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(context));
      yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
    }).pipe(
      Effect.scoped,
      Effect.timeout('60 seconds'),
      Effect.mapError(() => fail(`The step's host did not take the command ${command.type}.`)),
      Effect.catchDefect(() =>
        Effect.fail(fail(`The step's host did not take the command ${command.type}.`)),
      ),
    );
  });

  return { snapshot, dispatch };
};
