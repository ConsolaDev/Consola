import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  disconnectGitHub,
  finishGitHubInstall,
  listConnections,
  startGitHubInstall,
} from '../../application/connections.js';
import type { InstallOutcome } from '../../application/connections.js';
import type {
  GitHubApp,
  GitHubEventStore,
  InstallationStore,
  InstallStateSigner,
  WebhookSignatures,
} from '../../application/gitHubPorts.js';
import type { AgentRunPorts, Clock, MembershipReader } from '../../application/ports.js';
import { installationSettingsUrl, readGitHubId } from '../../domain/connections.js';
import { requireCaller } from './caller.js';
import type { WhoIsAsking } from './caller.js';
import {
  deleteGitHubInstallation,
  GitHubCallbackResult,
  getConnections,
  getGitHubCallback,
  postGitHubInstall,
  postGitHubWebhook,
} from './gitHubContract.js';
import type { GITHUB_CALLBACK_RESULTS } from './gitHubContract.js';
import { webhookRoutes } from './webhooks.js';
import type { WebhookLog } from './webhooks.js';

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

/** Every route `registerGitHubRoutes` registers, in the order it registers them. */
export const GITHUB_ROUTES = [
  getConnections,
  postGitHubInstall,
  getGitHubCallback,
  deleteGitHubInstallation,
  postGitHubWebhook,
];

/** What GitHub's routes need. */
export type GitHubRouteDeps = {
  /** Who a request's session says is asking (accounts' `currentSession`). */
  whoIsAsking: WhoIsAsking;
  /** Who is a member of which workspace, as `member` holds it now. */
  membership: MembershipReader;
  /** The web app's origin (`PUBLIC_URL`): where the callback sends the person back. */
  publicUrl: string;
  installations: InstallationStore;
  /** Null when the GitHub App is not configured on this server. */
  github: GitHubApp | null;
  installStates: InstallStateSigner;
  clock: Clock;
  /** GitHub's webhooks: null signatures when no webhook secret is set (`webhooks.ts`). */
  webhooks: {
    signatures: WebhookSignatures | null;
    events: GitHubEventStore;
    /** What starting an event's agent runs needs; left out, an event starts none. */
    agentRuns?: AgentRunPorts;
    log?: WebhookLog;
  };
};

/**
 * Registers GitHub's routes on `app`: Connections, Connect and Disconnect, which a page calls
 * and each take `requireCaller` as route middleware, so the role is the caller's at this request;
 * GitHub's callback, a browser redirect with no caller, which reads the signed-in person through
 * `whoIsAsking`; and the webhook, which GitHub calls with no session, and which the composition
 * exempts from the origin check (`GITHUB_WEBHOOK_PATH`). Each route asks a use case and maps its
 * answer to a status and a body.
 */
export function registerGitHubRoutes(app: OpenAPIHono, deps: GitHubRouteDeps): void {
  const { whoIsAsking, membership, publicUrl, installations, github, installStates, clock } = deps;
  const caller = requireCaller({ whoIsAsking, membership });

  // What the caller's workspace is connected to, for any of its members.
  app.openapi({ ...getConnections, middleware: [caller] as const }, async (c) => {
    const answer = await listConnections({ installations, github }, c.var.caller);
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
  app.openapi({ ...postGitHubInstall, middleware: [caller] as const }, (c) => {
    const answer = startGitHubInstall(
      { github, states: installStates },
      c.var.caller,
      clock.nowSeconds(),
    );
    if (answer.kind === 'not-allowed') return c.json({ error: 'not_allowed' } as const, 403);
    if (answer.kind === 'not-configured') {
      return c.json({ error: 'github_not_configured' } as const, 503);
    }
    c.header('cache-control', 'no-store');
    return c.json({ url: answer.url }, 200);
  });

  // Where GitHub sends the person back after installing the app (its "callback URL", with user
  // authorisation during installation on). It is a browser redirect, so it carries the session
  // cookie but no `x-consola-workspace`: the workspace is the one the state names, and the
  // person's role there is read for it. It ends on the web app's Settings, on its Connections
  // page, which reads `?github=` once. Its query is read as it comes, never validated: whatever
  // GitHub sends, it redirects.
  app.openapi(getGitHubCallback, async (c) => {
    const back = (result: CallbackResult) => {
      c.header('cache-control', 'no-store');
      // The address carried a code and a state; neither goes on in a Referer.
      c.header('referrer-policy', 'no-referrer');
      return c.redirect(`${publicUrl}/?github=${result}${CONNECTIONS_PAGE}`, 302);
    };
    const signedIn = await whoIsAsking(c.req.raw.headers);
    if (!signedIn) return back('signed_out');

    const query = (name: string) => c.req.query(name);
    const outcome = await finishGitHubInstall(
      { membership, installations, github, states: installStates },
      signedIn,
      {
        state: query('state'),
        code: query('code'),
        installationId: query('installation_id'),
        setupAction: query('setup_action'),
        error: query('error'),
      },
      clock.nowSeconds(),
    );
    return back(CALLBACK_RESULT[outcome.kind]);
  });
  // No body carries the results, so the document names them itself, for clients to check theirs.
  app.openAPIRegistry.register('GitHubCallbackResult', GitHubCallbackResult);

  // Disconnects an installation from the caller's workspace. The app stays installed on GitHub;
  // the answer to GET /api/connections says where to uninstall it.
  app.openapi({ ...deleteGitHubInstallation, middleware: [caller] as const }, async (c) => {
    const installationId = readGitHubId(c.req.valid('param').installationId);
    if (installationId === null) return c.json({ error: 'invalid_request' } as const, 400);

    const answer = await disconnectGitHub({ installations }, c.var.caller, installationId);
    if (answer.kind === 'not-allowed') return c.json({ error: 'not_allowed' } as const, 403);
    if (answer.kind === 'not-found') {
      return c.json({ error: 'installation_not_found' } as const, 404);
    }
    return c.body(null, 204);
  });

  // GitHub's webhooks: GitHub sends no Origin and no cookie, and the signature over the body is
  // what says a delivery is GitHub's.
  webhookRoutes(app, {
    signatures: deps.webhooks.signatures,
    installations,
    events: deps.webhooks.events,
    agentRuns: deps.webhooks.agentRuns,
    log: deps.webhooks.log ?? console,
  });
}
