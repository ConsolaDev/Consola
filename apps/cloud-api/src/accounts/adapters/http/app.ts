import { OpenAPIHono } from '@hono/zod-openapi';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { checkHealth } from '../../application/health.js';
import { describeMe } from '../../application/me.js';
import { listActiveWorkspaceMembers } from '../../application/members.js';
import type {
  HealthProbe,
  MembershipStore,
  SessionStore,
  WorkspaceStore,
} from '../../application/ports.js';
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
  getHealth,
  getMe,
  listWorkspaces,
  postWorkspace,
  putActiveWorkspace,
  putActiveWorkspaceIcon,
} from './contract.js';

const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** A workspace as the answers name it: with whether the person may change it (`canManage`). */
const workspaceAnswer = (workspace: MyWorkspace) => ({
  ...workspace,
  canManage: mayManageWorkspace(workspace.role),
});

/** The request's session, set by `requireSession` on the routes that need one. */
type WithSession = { Variables: { session: SignedIn } };

/** What the OpenAPI document says about the API, beside its routes. */
const DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'Consola Cloud global API',
    version: '0',
    description:
      'Who is signed in and their workspaces. Sign-in itself is Better Auth’s, under /api/auth, ' +
      'and is not described here.',
  },
};

/**
 * The HTTP API. Every route sits under `/api`, which the web app proxies to this service, and
 * every route but sign-in is in the contract (`contract.ts`), which TypeScript checks each answer
 * against. Each route asks a use case and maps its answer to a status and a body; sign-in itself
 * is handed to `handleAuth` whole. A request that changes something must come from the web app's
 * origin (`webOrigin`), as Better Auth requires of its own: the session cookie is SameSite=Lax,
 * which another site on the same host (any other localhost port) would still be sent.
 *
 * Order matters on a route: its session check runs before its body is read, so a signed-out
 * request is 401 whatever it sends. A body is checked for its shape before the handler runs; one
 * that is not JSON at all is 400 `invalid_request` (and 415 without a JSON content type), on every
 * route alike.
 */
export function createApp(deps: {
  handleAuth: (request: Request) => Promise<Response>;
  currentSession: (headers: Headers) => Promise<SignedIn | null>;
  webOrigin: string;
  workspaces: WorkspaceStore;
  memberships: MembershipStore;
  sessions: SessionStore;
  health: HealthProbe;
  /** The deployment's region, which every new workspace is made in. */
  region: Region;
}): OpenAPIHono {
  const { handleAuth, currentSession, webOrigin, workspaces, memberships, sessions, health } =
    deps;
  const { region } = deps;
  // A body of the wrong shape is 400 `invalid_request` unless its route says otherwise, never
  // the validator's own answer, which is not in the contract.
  const app = new OpenAPIHono({
    defaultHook: (result, c) =>
      result.success ? undefined : c.json({ error: 'invalid_request' } as const, 400),
  });

  // Hono's validator throws on a body that is not JSON, before any route's hook sees it.
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 400) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (error instanceof HTTPException && error.status === 415) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    if (error instanceof HTTPException) return error.getResponse();
    console.error(error);
    return c.text('Internal Server Error', 500);
  });

  app.all('/api/auth/*', (c) => handleAuth(c.req.raw));

  app.use('/api/*', async (c, next) => {
    if (!CHANGES.has(c.req.method) || c.req.header('origin') === webOrigin) return next();
    return c.json({ error: 'bad_origin' }, 403);
  });

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

  app.openapi(getHealth, async (c) => {
    if (await checkHealth(health)) return c.json({ ok: true } as const, 200);
    return c.json({ ok: false } as const, 503);
  });

  return app;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The OpenAPI document of `app`'s contract, as `openapi.json` holds it. */
export function describeApi(app: OpenAPIHono) {
  return app.getOpenAPI31Document(DOCUMENT);
}
