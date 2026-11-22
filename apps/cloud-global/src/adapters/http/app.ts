import { OpenAPIHono } from '@hono/zod-openapi';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { cellTokenKeys, mintCellToken } from '../../application/cellToken.js';
import {
  disconnectGitHub,
  finishGitHubInstall,
  type InstallOutcome,
  listConnections,
  startGitHubInstall,
} from '../../application/connections.js';
import { checkHealth } from '../../application/health.js';
import { describeMe } from '../../application/me.js';
import { listActiveWorkspaceMembers } from '../../application/members.js';
import type {
  CellEvents,
  CellTokenSigner,
  GitHubApp,
  GitHubEventSigner,
  HealthProbe,
  InstallationStore,
  InstallStateSigner,
  MembershipStore,
  SessionStore,
  WebhookSignatures,
  WorkspaceStore,
} from '../../application/ports.js';
import {
  createWorkspace,
  listMyWorkspaces,
  setActiveWorkspace,
} from '../../application/workspaces.js';
import { installationSettingsUrl, readGitHubId } from '../../domain/connections.js';
import type { SignedIn } from '../../domain/person.js';
import { checkNewWorkspace } from '../../domain/workspace.js';
import {
  deleteGitHubInstallation,
  type GITHUB_CALLBACK_RESULTS,
  GitHubCallbackResult,
  getActiveWorkspaceMembers,
  getCellTokenKeys,
  getConnections,
  getGitHubCallback,
  getHealth,
  getMe,
  listWorkspaces,
  postCellToken,
  postGitHubInstall,
  postWorkspace,
  putActiveWorkspace,
} from './contract.js';
import { type WebhookLog, webhookRoutes } from './webhooks.js';

const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Where in the web app a Connect ends: its Settings, on the Connections page. The web app keeps
 * the same address (`#/settings/connections`), so the two change together.
 */
const CONNECTIONS_PAGE = '#/settings/connections';

type CallbackResult = (typeof GITHUB_CALLBACK_RESULTS)[number];

/** How each way a Connect can end is named in `?github=`: every outcome, as the contract lists. */
const CALLBACK_RESULT = {
  connected: 'connected',
  'already-connected': 'already_connected',
  requested: 'requested',
  cancelled: 'cancelled',
  'bad-state': 'bad_state',
  expired: 'expired',
  'not-allowed': 'not_allowed',
  'code-refused': 'code_refused',
  'not-installer': 'not_installer',
  'not-account-admin': 'not_account_admin',
  taken: 'taken',
  invalid: 'invalid',
  unavailable: 'unavailable',
  'not-configured': 'not_configured',
} as const satisfies Record<InstallOutcome['kind'], CallbackResult>;

/** Now, in whole seconds since the epoch: what a cell token's times are in. */
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The request's session, set by `requireSession` on the routes that need one. */
type WithSession = { Variables: { session: SignedIn } };

/** What the OpenAPI document says about the API, beside its routes. */
const DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'Consola Cloud global API',
    version: '0',
    description:
      'The API every region shares: who is signed in, their workspaces and what each is ' +
      "connected to. Sign-in itself is Better Auth's, under /api/auth, and is not described here.",
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
  cellTokens: CellTokenSigner;
  installations: InstallationStore;
  /** Null when the GitHub App is not configured on this server. */
  github: GitHubApp | null;
  installStates: InstallStateSigner;
  health: HealthProbe;
  /** GitHub's webhooks: null signatures when no webhook secret is set (`webhooks.ts`). */
  webhooks: {
    signatures: WebhookSignatures | null;
    signer: GitHubEventSigner;
    cells: CellEvents;
    log?: WebhookLog;
  };
}): OpenAPIHono {
  const {
    handleAuth,
    currentSession,
    webOrigin,
    workspaces,
    memberships,
    sessions,
    cellTokens,
    installations,
    github,
    installStates,
    health,
    webhooks,
  } = deps;
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

  // GitHub's webhooks, before the origin check: GitHub sends no Origin and no cookie, and the
  // signature over the body is what says a delivery is GitHub's.
  webhookRoutes(app, { ...webhooks, installations, log: webhooks.log ?? console });

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
    return c.json(answer.me, 200);
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
    return c.json(answer.workspace, 200);
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
    c.json({ workspaces: await listMyWorkspaces(memberships, c.var.session.person) }, 200),
  );

  app.openapi(
    { ...postWorkspace, middleware: [requireSession] as const },
    async (c) => {
      const answer = await createWorkspace(
        { workspaces, sessions },
        c.var.session,
        c.req.valid('json'),
      );
      if (answer.kind === 'invalid') {
        return c.json({ error: 'invalid_workspace', problems: answer.problems } as const, 400);
      }
      if (answer.kind === 'slug-taken') return c.json({ error: 'slug_taken' } as const, 409);
      return c.json(answer.workspace, 201);
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

  // The token a cell trusts, for the session's active workspace. Nothing in the request names the
  // workspace or the role: both are read from the database as it is minted.
  app.openapi({ ...postCellToken, middleware: [requireSession] as const }, async (c) => {
    const answer = await mintCellToken(
      { memberships, signer: cellTokens },
      c.var.session,
      nowSeconds(),
    );
    if (answer.kind === 'no-workspace') {
      return c.json({ error: 'no_active_workspace' } as const, 409);
    }
    if (answer.kind === 'not-a-member') return c.json({ error: 'not_a_member' } as const, 403);
    // A token is a credential, so no cache keeps it.
    c.header('cache-control', 'no-store');
    const { token, expiresAt, workspaceId, region } = answer;
    return c.json({ token, expiresAt, workspaceId, region }, 200);
  });

  // The public keys a cell checks the token with, for anyone to read.
  app.openapi(getCellTokenKeys, (c) => c.json(cellTokenKeys(cellTokens), 200));

  // What the session's active workspace is connected to, for any of its members.
  app.openapi({ ...getConnections, middleware: [requireSession] as const }, async (c) => {
    const answer = await listConnections({ memberships, installations, github }, c.var.session);
    if (answer.kind === 'no-workspace') {
      return c.json({ error: 'no_active_workspace' } as const, 409);
    }
    if (answer.kind === 'not-a-member') return c.json({ error: 'not_a_member' } as const, 403);
    return c.json(
      {
        canManage: answer.canManage,
        github: {
          configured: answer.github.configured,
          installations: answer.github.installations.map(({ installation, repositories }) => ({
            id: installation.id,
            account: installation.account,
            connectedAt: installation.connectedAt.toISOString(),
            settingsUrl: installationSettingsUrl(installation),
            repositories,
          })),
        },
      },
      200,
    );
  });

  // Starts a Connect: the address that installs the GitHub App, which the web app sends the
  // person to. Only an owner or admin may.
  app.openapi({ ...postGitHubInstall, middleware: [requireSession] as const }, async (c) => {
    const answer = await startGitHubInstall(
      { memberships, github, states: installStates },
      c.var.session,
      nowSeconds(),
    );
    if (answer.kind === 'no-workspace') {
      return c.json({ error: 'no_active_workspace' } as const, 409);
    }
    if (answer.kind === 'not-a-member') return c.json({ error: 'not_a_member' } as const, 403);
    if (answer.kind === 'not-allowed') return c.json({ error: 'not_allowed' } as const, 403);
    if (answer.kind === 'not-configured') {
      return c.json({ error: 'github_not_configured' } as const, 503);
    }
    c.header('cache-control', 'no-store');
    return c.json({ url: answer.url }, 200);
  });

  // Where GitHub sends the person back after installing the app (its "callback URL", with user
  // authorisation during installation on). It is a browser redirect, so it carries the session
  // cookie, and it ends on the web app's Settings, on its Connections page, which reads
  // `?github=` once. Its query is read as it comes, never validated: whatever GitHub sends, it
  // redirects.
  app.openapi(getGitHubCallback, async (c) => {
    const back = (result: CallbackResult) => {
      c.header('cache-control', 'no-store');
      // The address carried a code and a state; neither goes on in a Referer.
      c.header('referrer-policy', 'no-referrer');
      return c.redirect(`${webOrigin}/?github=${result}${CONNECTIONS_PAGE}`, 302);
    };
    const session = await currentSession(c.req.raw.headers);
    if (!session) return back('signed_out');

    const query = (name: string) => c.req.query(name);
    const outcome = await finishGitHubInstall(
      { memberships, installations, github, states: installStates },
      session,
      {
        state: query('state'),
        code: query('code'),
        installationId: query('installation_id'),
        setupAction: query('setup_action'),
        error: query('error'),
      },
      nowSeconds(),
    );
    return back(CALLBACK_RESULT[outcome.kind]);
  });
  // No body carries the results, so the document names them itself, for clients to check theirs.
  app.openAPIRegistry.register('GitHubCallbackResult', GitHubCallbackResult);

  // Disconnects an installation from the session's active workspace. The app stays installed
  // on GitHub; the answer to GET /api/connections says where to uninstall it.
  app.openapi({ ...deleteGitHubInstallation, middleware: [requireSession] as const }, async (c) => {
    const installationId = readGitHubId(c.req.valid('param').installationId);
    if (installationId === null) return c.json({ error: 'invalid_request' } as const, 400);

    const answer = await disconnectGitHub(
      { memberships, installations },
      c.var.session,
      installationId,
    );
    if (answer.kind === 'no-workspace') {
      return c.json({ error: 'no_active_workspace' } as const, 409);
    }
    if (answer.kind === 'not-a-member') return c.json({ error: 'not_a_member' } as const, 403);
    if (answer.kind === 'not-allowed') return c.json({ error: 'not_allowed' } as const, 403);
    if (answer.kind === 'not-found') {
      return c.json({ error: 'installation_not_found' } as const, 404);
    }
    return c.body(null, 204);
  });

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
