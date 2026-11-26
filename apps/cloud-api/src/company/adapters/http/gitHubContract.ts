import { createRoute, z } from '@hono/zod-openapi';
import { GITHUB_PAYLOAD_MAX_BYTES } from '../../domain/webhooks.js';
import { callerFailures, WORKSPACE_HEADER } from './caller.js';

/**
 * GitHub's part of the API's contract: Connections (what a workspace is connected to, connecting
 * and disconnecting), GitHub's callback after an install, and the GitHub App's webhooks. `gitHub.ts`
 * implements these routes, and TypeScript checks each handler's answers against them.
 *
 * Answers are strict objects: the HTTP suite checks every body it gets against them, so a field
 * the contract does not name fails a test. The routes a page calls are behind `requireCaller`, so
 * each spreads `callerFailures` into its answers; a status one of them answers itself as well is
 * one union with the code there, since a status holds one answer. The callback and the webhook
 * have no caller: a browser redirect and GitHub reach them.
 */

const failure = <const Code extends string>(code: Code) =>
  z.strictObject({ error: z.literal(code) });

const json = <Schema extends z.ZodType>(schema: Schema, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

export const GitHubAccount = z
  .strictObject({
    id: z.number().int(),
    login: z.string(),
    type: z.enum(['Organization', 'User']),
  })
  .openapi('GitHubAccount', {
    description: 'The GitHub account, an organisation or a person, the app is installed on.',
  });

export const GitHubRepository = z
  .strictObject({
    id: z.number().int(),
    fullName: z.string(),
    private: z.boolean(),
    url: z.string(),
  })
  .openapi('GitHubRepository');

export const GitHubRepositories = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('listed'), repositories: z.array(GitHubRepository) }),
    z.strictObject({ kind: z.literal('gone') }),
    z.strictObject({ kind: z.literal('unavailable') }),
  ])
  .openapi('GitHubRepositories', {
    description:
      'What GitHub says the installation covers now: its repositories, `gone` when GitHub no ' +
      'longer has the installation (uninstalled or suspended there), or `unavailable` when ' +
      'GitHub did not say. Asked of GitHub each time, never stored.',
  });

export const GitHubConnection = z
  .strictObject({
    id: z.number().int(),
    account: GitHubAccount,
    connectedAt: z.string().openapi({ format: 'date-time' }),
    settingsUrl: z.string().openapi({
      description: 'Where on GitHub its repositories are chosen, and it is uninstalled.',
    }),
    repositories: GitHubRepositories,
  })
  .openapi('GitHubConnection', { description: 'A GitHub App installation the workspace holds.' });

export const Connections = z
  .strictObject({
    canManage: z.boolean().openapi({
      description: 'Whether the person may connect and disconnect: an owner or admin.',
    }),
    github: z.strictObject({
      configured: z
        .boolean()
        .openapi({ description: 'Whether this server has the GitHub App’s settings.' }),
      installations: z.array(GitHubConnection),
    }),
  })
  .openapi('Connections', { description: 'What the workspace is connected to.' });

/** The 403 of a change a page asks for that only an owner or admin may make. */
const managersOnly = json(
  z.union([failure('not_a_member'), failure('not_allowed'), failure('bad_origin')]),
  'The person is not a member of the workspace their session has active (`not_a_member`), ' +
    'is not an owner or admin of it (`not_allowed`), or the request did not come from the web ' +
    'app (`bad_origin`).',
);

export const getConnections = createRoute({
  method: 'get',
  path: '/api/connections',
  summary: "What my session's active workspace is connected to",
  description: `Any member may read it; \`canManage\` says whether they may change it. Takes \`${WORKSPACE_HEADER}\`.`,
  responses: {
    ...callerFailures,
    200: json(Connections, 'The workspace’s connections.'),
  },
});

export const postGitHubInstall = createRoute({
  method: 'post',
  path: '/api/connections/github/install',
  summary: 'Start connecting GitHub to my active workspace',
  description:
    'The address on GitHub that installs the app, carrying a state signed for this person. ' +
    'Only an owner or admin may. No cache keeps the answer (`Cache-Control: no-store`).',
  responses: {
    ...callerFailures,
    200: json(
      z.strictObject({ url: z.string() }).openapi('GitHubInstallAddress'),
      'Where to send the person.',
    ),
    403: managersOnly,
    503: json(failure('github_not_configured'), 'This server has no GitHub App settings.'),
  },
});

/** How a Connect ended, as the callback names it in the web app's `?github=`. */
export const GITHUB_CALLBACK_RESULTS = [
  'connected',
  'already_connected',
  'requested',
  'cancelled',
  'bad_state',
  'expired',
  'not_allowed',
  'code_refused',
  'not_installer',
  'not_account_admin',
  'taken',
  'invalid',
  'unavailable',
  'not_configured',
  'signed_out',
] as const;

/**
 * The results, as a named schema of the document (`gitHub.ts` registers it), so a client's own
 * list of them is checked against the contract's, though no route answers one in a body.
 */
export const GitHubCallbackResult = z
  .enum(GITHUB_CALLBACK_RESULTS)
  .openapi('GitHubCallbackResult', {
    description: 'How a Connect ended, as the callback names it in the web app’s `?github=`.',
  });

export const getGitHubCallback = createRoute({
  method: 'get',
  path: '/api/github/callback',
  summary: 'Where GitHub sends a person back after installing the app',
  description:
    'The GitHub App’s callback URL, reached by a browser redirect from GitHub with `state`, ' +
    '`code`, `installation_id`, `setup_action` or `error`. It never answers JSON: it always ' +
    'redirects to the web app’s Settings, on its Connections page, with how the Connect ended ' +
    `in \`?github=\`: one of ${GITHUB_CALLBACK_RESULTS.map((result) => `\`${result}\``).join(', ')}.`,
  responses: {
    302: {
      description: 'To `<PUBLIC_URL>/?github=<result>#/settings/connections`.',
      headers: z.object({ location: z.string() }),
    },
  },
});

// GitHub's webhooks (14.2). GitHub calls this route, with no session: it is in the contract so
// that every answer it gives is declared, typed and checked like any other route's.

/** The path the GitHub App's webhook URL ends in, on the tunnel's address in development. */
export const GITHUB_WEBHOOK_PATH = '/api/github/webhooks';

export const postGitHubWebhook = createRoute({
  method: 'post',
  path: GITHUB_WEBHOOK_PATH,
  summary: 'Receive one of the GitHub App’s webhook deliveries',
  description:
    'The GitHub App’s webhook URL. GitHub calls it, with no session and no Origin, so it is ' +
    'outside the origin check. The body is GitHub’s event payload as JSON, read as raw bytes ' +
    'and checked against `X-Hub-Signature-256` (HMAC-SHA256 under the app’s webhook secret, ' +
    'compared in constant time) before anything else is read; `X-GitHub-Event` names the ' +
    'event and `X-GitHub-Delivery` is GitHub’s id of the delivery, which it keeps when it ' +
    'sends a delivery again. The event is recorded for the workspace that holds its ' +
    'installation, once per delivery id, and an event recorded now starts the agent runs its ' +
    'factories’ teams fire.',
  responses: {
    200: json(
      z.strictObject({ result: z.literal('pong') }).openapi('GitHubWebhookPong', {
        description: 'GitHub’s ping, as a webhook is set up: recorded for no workspace.',
      }),
      'Answered.',
    ),
    201: json(
      z.strictObject({ result: z.literal('recorded') }).openapi('GitHubWebhookRecorded', {
        description: 'The event is recorded for the workspace that holds its installation.',
      }),
      'Recorded.',
    ),
    400: json(
      failure('invalid_delivery'),
      'Signed, but a header or the body is not what GitHub sends.',
    ),
    401: json(
      failure('bad_signature'),
      'No `X-Hub-Signature-256`, or not GitHub’s signature over this body.',
    ),
    409: json(
      failure('duplicate_delivery'),
      'The workspace had this delivery already: sent again, or replayed. Nothing changed.',
    ),
    413: json(
      failure('too_large'),
      `Over the ${GITHUB_PAYLOAD_MAX_BYTES} bytes (25 MB) GitHub puts in a delivery at most.`,
    ),
    422: json(
      z.union([failure('unknown_installation'), failure('no_installation')]),
      'Dropped: the event came through an installation no workspace holds, or through none.',
    ),
    503: json(
      z.union([failure('webhooks_not_configured'), failure('unavailable')]),
      'This server has no webhook secret (`GITHUB_WEBHOOK_SECRET`, `webhooks_not_configured`), ' +
        'or its database did not answer (`unavailable`): GitHub’s Redeliver sends it again.',
    ),
  },
});

export const deleteGitHubInstallation = createRoute({
  method: 'delete',
  path: '/api/connections/github/installations/{installationId}',
  summary: 'Disconnect a GitHub installation from my active workspace',
  description:
    'Removes the workspace’s record. The app stays installed on GitHub until someone ' +
    'uninstalls it there (`settingsUrl`). Only an owner or admin may.',
  request: {
    params: z.object({
      installationId: z.string().openapi({
        param: { name: 'installationId', in: 'path' },
        description: 'The installation’s id on GitHub, a positive whole number.',
      }),
    }),
  },
  responses: {
    ...callerFailures,
    204: { description: 'Disconnected.' },
    400: json(
      failure('invalid_request'),
      `No \`${WORKSPACE_HEADER}\` header, or the id is not a GitHub id.`,
    ),
    403: managersOnly,
    404: json(
      failure('installation_not_found'),
      'The workspace holds no installation with that id, whether or not another does.',
    ),
  },
});
