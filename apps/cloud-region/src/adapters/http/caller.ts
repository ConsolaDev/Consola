import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { type Authentication, authenticate } from '../../application/authenticate.js';
import type { Clock, TokenVerifier } from '../../application/ports.js';
import type { Caller } from '../../domain/caller.js';
import type { Region } from '../../domain/region.js';

/**
 * What a route behind `requireCaller` has on its context: the caller, read from the request's
 * checked cell token, and nothing else about who is asking.
 */
export type CellEnv = { Variables: { caller: Caller } };

/**
 * The credentials of an `Authorization: Bearer <token>` header, or null when the request has no
 * bearer credentials at all (no header, or another scheme). Whatever follows `Bearer` is handed
 * on as it is, empty or malformed included, and refused as an invalid token.
 */
export function bearerToken(header: string | undefined): string | null {
  const match = header === undefined ? null : /^bearer(?:\s+(.*))?$/is.exec(header.trim());
  return match ? (match[1] ?? '').trim() : null;
}

/** The answer to a request whose token was not accepted. Never says more than why. */
function refusal(
  c: Context,
  answer: Exclude<Authentication, { kind: 'accepted' }>,
  region: Region,
): Response {
  switch (answer.kind) {
    case 'missing':
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'token_required' }, 401);
    case 'invalid':
      c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
      return c.json({ error: 'invalid_token' }, 401);
    case 'other-region':
      // A good token that reached the wrong cell: another token will not help, another cell
      // will. The region is this cell's, which its health route says anyway.
      return c.json({ error: 'wrong_region', region }, 421);
    case 'keys-unavailable':
      // The cell cannot check any token just now; the token itself may be fine.
      return c.json({ error: 'token_check_unavailable' }, 503);
  }
}

/**
 * Lets a request through only with a cell token this cell accepts (`authenticate`), and sets
 * its caller on the context. Every route after it gets the caller and nothing else: none reads
 * who is asking, or which workspace, from the request.
 */
export function requireCaller(deps: { region: Region; tokens: TokenVerifier; clock: Clock }) {
  const { region, tokens, clock } = deps;
  return createMiddleware<CellEnv>(async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    const answer = await authenticate({ tokens, clock }, region, token);
    if (answer.kind !== 'accepted') return refusal(c, answer, region);
    c.set('caller', answer.caller);
    await next();
  });
}
