import type { OpenAPIHono } from '@hono/zod-openapi';
import { createMiddleware } from 'hono/factory';
import { describeMe } from '../../application/me.js';
import { listActiveWorkspaceMembers } from '../../application/members.js';
import type { MembershipStore, SessionStore, WorkspaceStore } from '../../application/ports.js';
import {
  createWorkspace,
  listMyWorkspaces,
  setActiveWorkspace,
  setWorkspaceIcon,
} from '../../application/workspaces.js';
import type { SignedIn } from '../../domain/person.js';
import type { Region } from '../../domain/region.js';
import { checkNewWorkspace, mayManageWorkspace } from '../../domain/workspace.js';
import type { MyWorkspace } from '../../domain/workspace.js';
import {
  getActiveWorkspaceMembers,
  getMe,
  listWorkspaces,
  postWorkspace,
  putActiveWorkspace,
  putActiveWorkspaceIcon,
} from './contract.js';

export { ACCOUNT_ROUTES } from './contract.js';

/** A workspace as the answers name it: with whether the person may change it (`canManage`). */
const workspaceAnswer = (workspace: MyWorkspace) => ({
  ...workspace,
  canManage: mayManageWorkspace(workspace.role),
});

/** The request's session, set by `requireSession` on the routes that need one. */
type WithSession = { Variables: { session: SignedIn } };

/** What accounts' routes are handed by the composition. */
export type AccountRouteDeps = {
  /** Better Auth's own handler, handed every request under `/api/auth` whole. */
  handleAuth: (request: Request) => Promise<Response>;
  /** A request's session, or null when it has none (`currentSessionOf`). */
  currentSession: (headers: Headers) => Promise<SignedIn | null>;
  workspaces: WorkspaceStore;
  memberships: MembershipStore;
  sessions: SessionStore;
  /** The deployment's region, which every new workspace is made in. */
  region: Region;
};

/**
 * Accounts' routes, on the app the composition hands in: sign-in (Better Auth's `/api/auth/*`,
 * handed to `handleAuth` whole), who is signed in, their workspaces and the active workspace's
 * members. Every route but sign-in is in the contract (`contract.ts`, `ACCOUNT_ROUTES`), which
 * TypeScript checks each answer against, and each asks a use case and maps its answer to a status
 * and a body.
 *
 * The app comes from the front door (`createFrontDoor`), which already answers a body that is not
 * JSON (400, or 415 without a JSON content type), a body of the wrong shape (400
 * `invalid_request`, unless a route says otherwise) and a change from another origin (403
 * `bad_origin`). On a route, the session check runs before the body is read, so a signed-out
 * request is 401 whatever it sends.
 */
export function registerAccountRoutes(app: OpenAPIHono, deps: AccountRouteDeps): void {
  const { handleAuth, currentSession, workspaces, memberships, sessions, region } = deps;

  app.all('/api/auth/*', (c) => handleAuth(c.req.raw));

  const requireSession = createMiddleware<WithSession>(async (c, next) => {
    const session = await currentSession(c.req.raw.headers);
    if (!session) return c.json({ error: 'signed_out' }, 401);
    c.set('session', session);
    await next();
  });

  app.openapi(getMe, async (c) => {
    const answer = await describeMe(memberships, await currentSession(c.req.raw.headers));
    if (answer.kind === 'signed-out') return c.json({ error: 'signed_out' } as const, 401);
    const { user, workspace } = answer.me;
    return c.json({ user, workspace: workspace && workspaceAnswer(workspace) }, 200);
  });

  app.openapi({ ...putActiveWorkspace, middleware: [requireSession] as const }, async (c) => {
    const answer = await setActiveWorkspace(
      { memberships, sessions },
      c.var.session,
      c.req.valid('json').workspaceId,
    );
    if (answer.kind === 'not-found') {
      return c.json({ error: 'workspace_not_found' } as const, 404);
    }
    return c.json(workspaceAnswer(answer.workspace), 200);
  });

  // The icon of the session's active workspace. Nothing in the request names the workspace or
  // the role: both are read from the database, and only the icon is written.
  app.openapi({ ...putActiveWorkspaceIcon, middleware: [requireSession] as const }, async (c) => {
    const answer = await setWorkspaceIcon(
      { memberships, workspaces },
      c.var.session,
      c.req.valid('json'),
    );
    if (answer.kind === 'no-workspace') {
      return c.json({ error: 'no_active_workspace' } as const, 409);
    }
    if (answer.kind === 'not-a-member') return c.json({ error: 'not_a_member' } as const, 403);
    if (answer.kind === 'not-allowed') return c.json({ error: 'not_allowed' } as const, 403);
    if (answer.kind === 'invalid') return c.json({ error: answer.problem } as const, 400);
    return c.json(workspaceAnswer(answer.workspace), 200);
  });

  app.openapi(
    { ...getActiveWorkspaceMembers, middleware: [requireSession] as const },
    async (c) => {
      const answer = await listActiveWorkspaceMembers(memberships, c.var.session);
      if (answer.kind === 'no-workspace') {
        return c.json({ error: 'no_active_workspace' } as const, 409);
      }
      if (answer.kind === 'not-a-member') return c.json({ error: 'not_a_member' } as const, 403);
      return c.json({ members: answer.members }, 200);
    },
  );

  app.openapi({ ...listWorkspaces, middleware: [requireSession] as const }, async (c) =>
    c.json(
      {
        workspaces: (await listMyWorkspaces(memberships, c.var.session.person)).map(
          workspaceAnswer,
        ),
      },
      200,
    ),
  );

  app.openapi(
    { ...postWorkspace, middleware: [requireSession] as const },
    async (c) => {
      const answer = await createWorkspace(
        { workspaces, sessions },
        c.var.session,
        c.req.valid('json'),
        region,
      );
      if (answer.kind === 'invalid') {
        return c.json({ error: 'invalid_workspace', problems: answer.problems } as const, 400);
      }
      if (answer.kind === 'slug-taken') return c.json({ error: 'slug_taken' } as const, 409);
      return c.json(workspaceAnswer(answer.workspace), 201);
    },
    // A body of the wrong shape still gets every problem named: the rules say what they are.
    // The schema checks only types the rules check too, so the rules refuse whatever it does.
    (result, c) =>
      result.success
        ? undefined
        : c.req.json().then((sent: unknown) => {
            const checked = checkNewWorkspace(isObject(sent) ? sent : {});
            const problems = checked.ok ? [] : checked.problems;
            return c.json({ error: 'invalid_workspace', problems } as const, 400);
          }),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
