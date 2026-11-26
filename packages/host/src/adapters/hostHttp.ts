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
 *   socket (`auth/http.ts` `"webSocketTicketFor"`, `EnvironmentAuth.issueWebSocketTicket`): never
 *   the pass, but random, in memory, good for one socket once and for a few seconds
 *   (`socketTickets.ts`), so the pass travels in a header alone and never in a socket's URL.
 * - `GET /api/auth/session` with the same header: who the pass lets in, and until when
 *   (`auth/http.ts` `"session"`, `EnvironmentAuth.getSessionState`).
 *
 * And, behind the same header, the two orchestration reads t3's client makes over HTTP once it is
 * connected (t3's `orchestration-v2/http.ts`):
 *
 * - `GET /api/orchestration/shell`: the session's shell (`hostShell.ts`), which t3's client loads
 *   before it follows it over the socket (`state/shell.ts`).
 * - `GET /api/orchestration/threads/:threadId/bounded`: the session's thread as one window that
 *   holds all of it, no older history to page (`"threadBoundedSnapshot"`), which t3's client asks
 *   for when it opens a thread cold again, after a first open over the socket that failed or
 *   dropped before its data arrived (`state/threads.ts`). Another thread id is t3's `404`
 *   `EnvironmentResourceNotFoundError` (`thread_not_found`), as for a thread that is not there.
 *
 * Each checks the pass first, as t3's `EnvironmentAuthenticatedAuth` runs before its handler,
 * then t3's orchestration protocol header, which t3's endpoints declare (an empty `400`, as t3's
 * schema refuses a header).
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
  EnvironmentResourceNotFoundError,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2ShellHttpSnapshot,
  OrchestrationV2ShellResumable,
  OrchestrationV2ThreadBoundedSnapshot,
} from '@t3tools/contracts';
import type { ServerAuthDescriptor } from '@t3tools/contracts';
import * as Cause from 'effect/Cause';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import * as HttpMiddleware from 'effect/http/HttpMiddleware';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Schema from 'effect/Schema';
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from 't3/httpCors.ts';
import { computeLatestLocalTurnOrdinal } from 't3/orchestration-v2/threadHistoryPaging.ts';
import { boundedSnapshotResponseFields } from 't3/orchestration-v2/ThreadStream.ts';
import { projectThreadProjectionForWire } from 't3/orchestration-v2/WireProjection.ts';
import type { PassClaims } from '../core/pass.ts';
import { readableThread } from '../runtime/threadRuntime.ts';
import type { ThreadHandle } from '../runtime/threadRuntime.ts';
import { shellHttpAnswer } from './hostShell.ts';
import type { PassRejected } from './passVerifier.ts';
import type { IssuedTicket } from './socketTickets.ts';

export const DESCRIPTOR_PATH = '/.well-known/t3/environment';
export const SESSION_PATH = '/api/auth/session';
export const RPC_TICKET_PATH = '/api/auth/websocket-ticket/rpc';
export const SHELL_PATH = '/api/orchestration/shell';
/** `/api/orchestration/threads/:threadId/bounded`, the id as t3's client encodes it. */
const BOUNDED_THREAD_PATH = /^\/api\/orchestration\/threads\/([^/]+)\/bounded$/;

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
  /** A socket ticket for a pass just verified (`socketTickets.ts`). */
  readonly issueTicket: (claims: PassClaims) => Effect.Effect<IssuedTicket>;
  /** The session's thread: its shell and its snapshot. */
  readonly runtime: ThreadHandle;
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
        http.issueTicket(claims).pipe(
          Effect.flatMap((issued) =>
            HttpServerResponse.schemaJson(AuthWebSocketTicketResult)({
              ticket: Redacted.make(issued.ticket),
              expiresAt: DateTime.makeUnsafe(issued.expiresAtMs),
            }),
          ),
        ),
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
 * The orchestration reads, as t3's endpoints run them: the pass (`401` as above), then t3's
 * orchestration protocol header, which its endpoints declare and its schema answers with an
 * empty `400` when it is missing or another. Nothing of the thread is read before both hold.
 */
const orchestrationRead = <E, R>(
  http: HostHttp,
  request: HttpServerRequest.HttpServerRequest,
  answer: () => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  http.verify(bearerPass(request)).pipe(
    Effect.matchEffect({
      onFailure: respondRefused,
      onSuccess: () =>
        request.headers[ORCHESTRATION_PROTOCOL_HEADER] === ORCHESTRATION_PROTOCOL_VERSION_TEXT
          ? answer()
          : Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    }),
  );

/** A query flag as t3's endpoints read one: on when it is `1`. */
const flag = (url: URL, name: string) => url.searchParams.get(name) === '1';

const isResumable = Schema.is(OrchestrationV2ShellResumable);

/**
 * t3's `"shellSnapshot"` handler (`answerShellSnapshot`): the session's shell, or `resumable` for
 * a `resumeFrom` cursor the socket can resume from. A cursor that is no whole number is ignored,
 * as t3 ignores it.
 */
const shellSnapshot = (http: HostHttp, url: URL) => {
  const asked = Number(url.searchParams.get('resumeFrom') ?? Number.NaN);
  const resumeFrom = Number.isSafeInteger(asked) && asked >= 0 ? asked : undefined;
  return shellHttpAnswer(http.runtime, resumeFrom).pipe(
    Effect.flatMap((answer) =>
      isResumable(answer)
        ? HttpServerResponse.schemaJson(OrchestrationV2ShellResumable)(answer)
        : HttpServerResponse.schemaJson(OrchestrationV2ShellHttpSnapshot)(answer),
    ),
  );
};

/**
 * t3's `"threadBoundedSnapshot"` handler for the session's thread, as one window that holds the
 * whole thread (t3's bounded history windows are left out, so no `historyCursor` and nothing more
 * to page), shaped for the wire by t3's `boundedSnapshotResponseFields` as the client's flags ask.
 * Another thread is not there.
 */
const boundedThreadSnapshot = (http: HostHttp, url: URL, threadId: string) => {
  // The session's thread, or an agent run's dispatched agent's (read-only).
  const runtime = readableThread(http.runtime, http.runtime.snapshot().thread.id, threadId);
  if (runtime === undefined) {
    return HttpServerResponse.schemaJson(EnvironmentResourceNotFoundError)(
      new EnvironmentResourceNotFoundError({
        code: 'not_found',
        reason: 'thread_not_found',
        traceId: TRACE_ID,
      }),
      { status: 404 },
    );
  }
  // Read together: `snapshotSequence()` is the last event `snapshot()` holds.
  const snapshotSequence = runtime.snapshotSequence();
  const projection = projectThreadProjectionForWire(runtime.snapshot());
  return HttpServerResponse.schemaJson(OrchestrationV2ThreadBoundedSnapshot)({
    snapshotSequence,
    ...boundedSnapshotResponseFields({
      bounded: {
        projection,
        historyCursor: null,
        hasMoreHistory: false,
        latestLocalTurnOrdinal: computeLatestLocalTurnOrdinal(projection.turnItems),
      },
      compactTurnItems: flag(url, 'compactTurnItems'),
      dedupeBodies: flag(url, 'dedupeBodies'),
      compactIds: flag(url, 'compactIds'),
    }),
  });
};

/** The thread id in a bounded snapshot's path, or `null` for any other path. */
const boundedThreadIdOf = (path: string): string | null => {
  const encoded = BOUNDED_THREAD_PATH.exec(path)?.[1];
  if (encoded === undefined) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
};

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
 * path, before a pass is looked at. Each answer carries t3's CORS headers, so a page on another
 * origin can read it, a `404` included, and a preflight is answered.
 */
export const serveHostHttp = (http: HostHttp, url: URL) =>
  cors(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = url.pathname;
      if (path === DESCRIPTOR_PATH && request.method === 'GET') return yield* descriptor(http);
      if (path === SESSION_PATH && request.method === 'GET') {
        return yield* sessionState(http, bearerPass(request));
      }
      if (path === RPC_TICKET_PATH && request.method === 'POST') {
        return yield* webSocketTicket(http, bearerPass(request));
      }
      if (path === SHELL_PATH && request.method === 'GET') {
        return yield* orchestrationRead(http, request, () => shellSnapshot(http, url));
      }
      const boundedThreadId = request.method === 'GET' ? boundedThreadIdOf(path) : null;
      if (boundedThreadId !== null) {
        return yield* orchestrationRead(http, request, () =>
          boundedThreadSnapshot(http, url, boundedThreadId),
        );
      }
      return HttpServerResponse.empty({ status: 404 });
    }),
  ).pipe(
    // A failure here is the host's own (a refused pass is an answer, above). It is logged, with
    // the request's pass taken out, and answered `500`.
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const pass = bearerPass(request);
        const detail = Cause.pretty(cause);
        yield* Effect.logError(
          `Host HTTP ${request.method} ${url.pathname} failed; answered 500.`,
          pass === '' ? detail : detail.replaceAll(pass, '[pass]'),
        );
        return HttpServerResponse.empty({ status: 500 });
      }),
    ),
  );
