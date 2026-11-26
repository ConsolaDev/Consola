/**
 * An agent run's tools over MCP's Streamable HTTP (`POST /mcp`, as a stateless tool server), on the
 * host's own port: the endpoint t3's adapters hand each of the run's threads as t3's `t3-code` MCP
 * server (`runtime/agentRunMcp.ts`), with a bearer token of the thread's own.
 *
 * A sandbox's port is reachable from outside, so nothing here works without a token: a method
 * other than `POST` is `405`, a missing or wrong token `401`, both before the body is read. The
 * token says which thread is calling (compared in constant time, `threadForToken`), and is never
 * logged or echoed. Each JSON-RPC message is answered as `core/mcpProtocol.ts` reads it; a body of
 * notifications alone is `202` with nothing in it, and no stream is ever opened (`GET` is `405`, as
 * MCP lets a server that offers none answer).
 */
import * as ByteSize from 'effect/ByteSize';
import * as Effect from 'effect/Effect';
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import type { ThreadId } from '@t3tools/contracts';
import {
  callToolResult,
  initializeResult,
  listToolsResult,
  mcpError,
  pingResult,
  readMcpMessage,
  unknownMethod,
} from '../core/mcpProtocol.ts';
import type { AgentRunSession } from '../runtime/threadRuntime.ts';

export { MCP_PATH } from '../runtime/agentRunMcp.ts';

/** The largest request body `/mcp` reads: a tool call's brief, with room to spare. */
const MCP_BODY_MAX = ByteSize.mebibytes(4);

/** The token in an `Authorization: Bearer <token>` header, or `''`. */
const bearerToken = (request: HttpServerRequest.HttpServerRequest): string => {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
};

const jsonAnswer = (body: unknown, status = 200) =>
  HttpServerResponse.text(JSON.stringify(body), {
    status,
    contentType: 'application/json',
  });

/** One JSON-RPC message's answer, or null for a notification or a reply. */
const answerOne = (
  agentRun: AgentRunSession,
  caller: ThreadId,
  message: unknown,
): Effect.Effect<unknown> => {
  const request = readMcpMessage(message);
  switch (request.kind) {
    case 'quiet':
      return Effect.succeed(null);
    case 'invalid':
      return Effect.succeed(mcpError(request.id, request.problem));
    case 'unknown-method':
      return Effect.succeed(unknownMethod(request.id, request.method));
    case 'initialize':
      return Effect.succeed(initializeResult(request.id, request.protocolVersion));
    case 'ping':
      return Effect.succeed(pingResult(request.id));
    case 'list-tools':
      return Effect.succeed(listToolsResult(request.id, agentRun.tools));
    case 'call-tool':
      return agentRun
        .callTool(caller, request.name, request.arguments)
        .pipe(Effect.map((answer) => callToolResult(request.id, answer)));
  }
};

const parseJson = (
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

/**
 * Answers one request to `/mcp` for an agent run: the method and the token first, then the body.
 * A failure of the host's own is logged (no token in it) and answered `500`.
 */
export const serveMcp = Effect.fn('serveMcp')(
  function* (agentRun: AgentRunSession) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== 'POST') {
      return HttpServerResponse.empty({ status: 405, headers: { allow: 'POST' } });
    }
    const caller = agentRun.threadForToken(bearerToken(request));
    if (caller === null) return HttpServerResponse.empty({ status: 401 });
    const body = yield* request.text.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, MCP_BODY_MAX),
      Effect.result,
    );
    if (body._tag === 'Failure') return HttpServerResponse.empty({ status: 413 });
    const parsed = parseJson(body.success);
    if (!parsed.ok) return jsonAnswer(mcpError(null, 'Parse error'), 400);
    const batch = Array.isArray(parsed.value);
    const messages: readonly unknown[] = batch ? (parsed.value as unknown[]) : [parsed.value];
    const answers = (yield* Effect.forEach(messages, (message) =>
      answerOne(agentRun, caller, message),
    )).filter((answer) => answer !== null);
    if (answers.length === 0) return HttpServerResponse.empty({ status: 202 });
    return jsonAnswer(batch ? answers : answers[0]);
  },
  Effect.catchCause((cause) =>
    Effect.logError('The agent run’s /mcp request failed; answered 500.', cause).pipe(
      Effect.as(HttpServerResponse.empty({ status: 500 })),
    ),
  ),
);
