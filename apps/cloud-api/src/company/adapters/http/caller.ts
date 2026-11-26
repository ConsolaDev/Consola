import { z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { MembershipReader } from '../../application/ports.js';
import { admitCaller } from '../../domain/caller.js';
import type { Caller, SignedInPerson } from '../../domain/caller.js';

/**
 * The header every company request carries: the id of the workspace its page shows. It is only
 * a guard against a session another tab switched; the workspace acted on is the session's.
 */
export const WORKSPACE_HEADER = 'x-consola-workspace';

/**
 * What a route behind `requireCaller` has on its context: the caller, admitted from the
 * request's session and the person's membership, and nothing else about who is asking.
 */
export type CompanyEnv = { Variables: { caller: Caller } };

/** The cell's name for `CompanyEnv`, kept until every route file says `CompanyEnv`. */
export type CellEnv = CompanyEnv;

/** Who a request's session says is asking (accounts' `currentSession`), or null for none. */
export type WhoIsAsking = (headers: Headers) => Promise<SignedInPerson | null>;

/** The workspace a request's page shows, or null when the header is missing or empty. */
function shownWorkspaceOf(header: string | undefined): string | null {
  const shown = header?.trim() ?? '';
  return shown === '' ? null : shown;
}

/**
 * Lets a request through only for a member asking about the workspace their session has active
 * (`admitCaller`), and sets its caller on the context. The role is read for the session's active
 * workspace alone, never for the one the header names, and only once the two agree, since any
 * refusal before it needs no role. Every route after it gets the caller and nothing else: none
 * reads who is asking, or which workspace, from the request.
 */
export function requireCaller(deps: {
  whoIsAsking: WhoIsAsking;
  membership: MembershipReader;
}): MiddlewareHandler<CompanyEnv> {
  const { whoIsAsking, membership } = deps;
  return createMiddleware<CompanyEnv>(async (c, next) => {
    const signedIn = await whoIsAsking(c.req.raw.headers);
    const shownWorkspaceId = shownWorkspaceOf(c.req.header(WORKSPACE_HEADER));
    const active = signedIn?.activeWorkspaceId ?? null;
    const role =
      signedIn !== null && active !== null && shownWorkspaceId === active
        ? await membership.roleOf(signedIn.personId, active)
        : null;
    const admission = admitCaller({ signedIn, shownWorkspaceId, role });
    if (!admission.ok) return c.json({ error: admission.error }, admission.status);
    c.set('caller', admission.caller);
    await next();
  });
}

const failure = <const Code extends string>(code: Code) =>
  z.strictObject({ error: z.literal(code) });

const json = <Schema extends z.ZodType>(schema: Schema, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

/**
 * What every route behind `requireCaller` can answer before it runs. Spread into each such
 * route's responses, so the contract says it once. A route that answers one of these statuses
 * itself declares it after the spread, as one union with the code here, since a status holds
 * one answer.
 */
export const callerFailures = {
  400: json(
    failure('invalid_request'),
    `No \`${WORKSPACE_HEADER}\` header: the request does not say which workspace its page shows.`,
  ),
  401: json(failure('signed_out'), 'No session: the person is signed out.'),
  403: json(
    failure('not_a_member'),
    'The person is not a member of the workspace their session has active, or no longer.',
  ),
  409: json(
    z.union([failure('no_active_workspace'), failure('workspace_switched')]),
    'The session has no workspace active (`no_active_workspace`), or another than the page ' +
      'shows (`workspace_switched`): another tab switched it. Loading the page again is the fix.',
  ),
} as const;
