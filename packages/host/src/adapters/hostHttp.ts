/**
 * The three HTTP calls t3's client-runtime makes before it opens a bearer environment's socket
 * (`connection/resolver.ts` → `authorization/service.ts` `authorizeBearer`), and its session
 * read once connected (`state/session.ts`), answered for one session with its pass as the bearer
 * token. Each follows t3's handler and answers with t3's own schemas, so t3's unchanged client
 * reads them as it reads t3's server:
 *
 * - `GET /.well-known/t3/environment`: the environment's descriptor, unauthenticated as in t3
 *   (`http.ts` `layerServerEnvironmentHttpApi`, `"descriptor"`).
 * - `POST /api/auth/websocket-ticket/rpc` with `Authorization: Bearer <pass>`: a ticket for the
 *   socket (`auth/http.ts` `"webSocketTicketFor"`, `EnvironmentAuth.issueWebSocketTicket`). The
 *   host keeps no sessions, so the ticket is the pass itself, which the socket verifies again:
 *   the pass stays the only credential.
 * - `GET /api/auth/session` with the same header: who the pass lets in, and until when
 *   (`auth/http.ts` `"session"`, `EnvironmentAuth.getSessionState`).
 *
 * A refused pass is t3's `EnvironmentAuthInvalidError` (`401`), which t3's client reads as "the
 * credential is invalid" and stops on (`ConnectionBlockedError`, `authentication`): that is where
 * `@consola/agent-ui` asks for a new pass. The session read answers a refused pass
 * `authenticated: false`, as t3's does.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionState,
  AuthWebSocketTicketResult,
  authScopeResponse,
  EnvironmentAuthInvalidError,
  ExecutionEnvironmentDescriptor,
  type ServerAuthDescriptor,
} from '@t3tools/contracts';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import * as HttpMiddleware from 'effect/http/HttpMiddleware';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from 't3/httpCors.ts';
import type { PassClaims } from '../core/pass.ts';
import type { PassRejected } from './passVerifier.ts';

export const DESCRIPTOR_PATH = '/.well-known/t3/environment';
export const SESSION_PATH = '/api/auth/session';
export const RPC_TICKET_PATH = '/api/auth/websocket-ticket/rpc';

/**
 * What a pass lets a client do: read the thread and act on it. The host serves nothing else
 * (`SERVED_METHODS`), so it grants nothing else, and t3's UI offers nothing that needs more.
 */
export const HOST_SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;

/** t3's errors carry a trace id; the host traces nothing, so it says so. */
const TRACE_ID = 'untraced';

export interface HostHttp {
  readonly environment: ExecutionEnvironmentDescriptor;
  readonly auth: ServerAuthDescriptor;
  /** Verifies a pass for this session, now. */
  readonly verify: (pass: string) => Effect.Effect<PassClaims, PassRejected>;
}

/** The pass in an `Authorization: Bearer <pass>` header, or `''`. */
const bearerPass = (request: HttpServerRequest.HttpServerRequest): string => {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
};

const expiresAt = (claims: PassClaims) => DateTime.makeUnsafe(claims.exp * 1000);

/**
 * A refused pass, as t3's `EnvironmentAuthenticatedAuth` refuses a bearer token: `401`
 * `EnvironmentAuthInvalidError`, the only refusal the ticket call declares. A pass naming another
 * session is an invalid credential here too (t3 has no other answer; the socket's `4403` stays).
 */
const respondRefused = (rejected: PassRejected) =>
  HttpServerResponse.schemaJson(EnvironmentAuthInvalidError)(
    new EnvironmentAuthInvalidError({
      code: 'auth_invalid',
      reason: rejected.reason === 'missing' ? 'missing_credential' : 'invalid_credential',
      traceId: TRACE_ID,
    }),
    { status: 401 },
  );

const descriptor = (http: HostHttp) =>
  HttpServerResponse.schemaJson(ExecutionEnvironmentDescriptor)(http.environment);

const webSocketTicket = (http: HostHttp, pass: string) =>
  http.verify(pass).pipe(
    Effect.matchEffect({
      onFailure: respondRefused,
      onSuccess: (claims) =>
        HttpServerResponse.schemaJson(AuthWebSocketTicketResult)({
          ticket: Redacted.make(pass),
          expiresAt: expiresAt(claims),
        }),
    }),
  );

const sessionState = (http: HostHttp, pass: string) =>
  http.verify(pass).pipe(
    Effect.match({
      onFailure: (): AuthSessionState => ({ authenticated: false, auth: http.auth }),
      onSuccess: (claims): AuthSessionState => ({
        authenticated: true,
        auth: http.auth,
        ...authScopeResponse(HOST_SCOPES),
        sessionMethod: 'bearer-access-token',
        expiresAt: expiresAt(claims),
      }),
    }),
    Effect.flatMap((state) => HttpServerResponse.schemaJson(AuthSessionState)(state)),
  );

/**
 * t3's browser API CORS (`http.ts` `layerBrowserApiCors`, with t3's lists from the lifted
 * `httpCors.ts`), as a packaged t3 server sends it: any origin, no cookies, so a page on another
 * origin can make these calls with the pass in a header.
 */
const cors = HttpMiddleware.cors({
  allowedMethods: browserApiCorsAllowedMethods,
  allowedHeaders: browserApiCorsAllowedHeaders,
  maxAge: 600,
});

/**
 * Answers every request but the socket's: one of these calls, or a `404` for any other method or
 * path, before a pass is looked at. Each answer carries t3's CORS headers, so t3's client can
 * read a `404` (its HTTP snapshot loaders then fall back to the socket, as against an older t3
 * server), and a preflight is answered.
 */
export const serveHostHttp = (http: HostHttp, path: string) =>
  cors(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (path === DESCRIPTOR_PATH && request.method === 'GET') return yield* descriptor(http);
      if (path === SESSION_PATH && request.method === 'GET') {
        return yield* sessionState(http, bearerPass(request));
      }
      if (path === RPC_TICKET_PATH && request.method === 'POST') {
        return yield* webSocketTicket(http, bearerPass(request));
      }
      return HttpServerResponse.empty({ status: 404 });
    }),
  ).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 500 }))));
