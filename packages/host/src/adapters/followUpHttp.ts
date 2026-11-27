/**
 * A person's follow-up to an agent run (`POST /agent-run/follow-ups`, the protocol's
 * `FOLLOW_UP_PATH`), on the host's own port: the cell's call that hands the orchestrator a message
 * a person wrote while the run goes on, such as a reply in the Slack thread it answers in.
 *
 * Only an agent run's host serves it; for every other session the path is the `404` any unknown
 * path is (`rpcServer.ts`). A method other than `POST` is `405`, and the pass comes before the
 * body: one this host would not take (`verify`, as for the socket's ticket) is `401`. Then the
 * body, at most `FOLLOW_UP_BODY_MAX_BYTES` (`413`), read by the protocol's `readFollowUp` (`400`
 * with the reader's reason, which names a field and never its contents). The person is the
 * pass's `sub`; the body names no one. What the host runs is one `message.dispatch` into the
 * orchestrator's thread, composed in `core/followUp.ts` (`AgentRunHandle.followUp`), and nothing
 * else. Its answer is the protocol's `FollowUpReceipt`, or `503` while the run's prompt is not yet
 * sent.
 *
 * No CORS: the cell calls it, never a page. A failure is logged by its name alone, with the
 * session and the key: never its message or what it carries, since a refusal of t3's can hold the
 * command it was handed, and the person's text with it. The pass and the text are never logged.
 */
import { FOLLOW_UP_BODY_MAX_BYTES, readFollowUp } from '@consola/runner-protocol';
import type { FollowUpReceipt } from '@consola/runner-protocol';
import * as ByteSize from 'effect/ByteSize';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import type { PassClaims } from '../core/pass.ts';
import type { AgentRunSession } from '../runtime/threadRuntime.ts';
import type { PassRejected } from './passVerifier.ts';

export { FOLLOW_UP_PATH } from '@consola/runner-protocol';

/** How long the cell is asked to wait before it sends a follow-up the host was not ready for. */
const NOT_READY_RETRY_SECONDS = 5;

/** The pass in an `Authorization: Bearer <pass>` header, or `''`. */
const bearerPass = (request: HttpServerRequest.HttpServerRequest): string => {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
};

const jsonAnswer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  HttpServerResponse.text(JSON.stringify(body), {
    status,
    contentType: 'application/json',
    headers,
  });

const parseJson = (
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

/** A name as a log may carry it: a tag or a class, letters and digits alone. */
const NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/**
 * What a failure is, for the log: its tag, or its class, and nothing else. Never its message,
 * its cause or its fields, which may hold the command t3 was handed, and the text in it.
 */
const failureName = (cause: Cause.Cause<unknown>): string => {
  if (Cause.hasInterruptsOnly(cause)) return 'Interrupted';
  const failure = Cause.squash(cause);
  if (typeof failure !== 'object' || failure === null) return 'unknown';
  const tag = (failure as { readonly _tag?: unknown })._tag;
  if (typeof tag === 'string' && NAME.test(tag)) return tag;
  if (failure instanceof Error && NAME.test(failure.name)) return failure.name;
  return 'unknown';
};

/** Answers one request to an agent run's follow-up path, for the session `sessionId`. */
export const serveFollowUp = Effect.fn('serveFollowUp')(
  function* (
    agentRun: Pick<AgentRunSession, 'followUp'>,
    verify: (pass: string) => Effect.Effect<PassClaims, PassRejected>,
    sessionId: string,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== 'POST') {
      return HttpServerResponse.empty({ status: 405, headers: { allow: 'POST' } });
    }
    const verified = yield* verify(bearerPass(request)).pipe(Effect.result);
    if (verified._tag === 'Failure') return jsonAnswer({ error: 'pass_refused' }, 401);
    const body = yield* request.text.pipe(
      Effect.provideService(
        HttpIncomingMessage.MaxBodySize,
        ByteSize.bytes(FOLLOW_UP_BODY_MAX_BYTES),
      ),
      Effect.result,
    );
    if (body._tag === 'Failure') return jsonAnswer({ error: 'too_large' }, 413);
    const parsed = parseJson(body.success);
    if (!parsed.ok) return jsonAnswer({ error: 'not_json' }, 400);
    const read = readFollowUp(parsed.value);
    if (!read.ok) return jsonAnswer({ error: 'invalid_follow_up', reason: read.reason }, 400);
    const { key, text, authorLabel } = read.value;

    const delivered = yield* agentRun
      .followUp({ key, text, author: { personId: verified.success.sub, label: authorLabel } })
      .pipe(Effect.result);
    if (delivered._tag === 'Failure') {
      yield* Effect.logError(
        `Session ${sessionId}: the follow-up ${key} was refused by t3 (${failureName(Cause.fail(delivered.failure))}); answered 500.`,
      );
      return jsonAnswer({ error: 'not_delivered' }, 500);
    }
    if (delivered.success === 'not-ready') {
      return jsonAnswer({ error: 'not_ready' }, 503, {
        'retry-after': String(NOT_READY_RETRY_SECONDS),
      });
    }
    const receipt: FollowUpReceipt = { outcome: delivered.success };
    return jsonAnswer(receipt);
  },
  // A failure of the host's own: logged by its name alone, and answered 500.
  (effect, _agentRun, _verify, sessionId) =>
    Effect.catchCause(effect, (cause) =>
      Effect.logError(
        `Session ${sessionId}: a follow-up failed inside the host (${failureName(cause)}); answered 500.`,
      ).pipe(Effect.as(HttpServerResponse.empty({ status: 500 }))),
    ),
);
