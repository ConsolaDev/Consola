import { createRoute, z } from '@hono/zod-openapi';
import {
  SLACK_APP_STATES,
  SLACK_BOT_EVENTS,
  SLACK_BOT_SCOPES,
  SLACK_CREDENTIAL_PROBLEMS,
  SLACK_OAUTH_CALLBACK_PATH,
} from '../../domain/slack.js';
import { callerFailures, changeFailures } from './caller.js';

/**
 * Slack's part of the API's contract (CON-144): a factory's Slack app (its state, its credentials,
 * "Add to Slack" and Disconnect), Slack's redirect back after "Add to Slack", and the Slack
 * accounts people link to theirs. `slack.ts` implements these routes. Slack's events
 * (`POST /api/slack/events/{factoryId}`) are declared and served beside them, in their own file.
 *
 * Every route a page calls is behind `requireCaller`, so it spreads `callerFailures`, or
 * `changeFailures` for a change; a status it answers itself as well is one union with the
 * check's codes there. Answers are strict objects. With no `CONNECTION_SECRETS_KEY`, Slack is off,
 * and each of these routes answers 503 `slack_not_configured`.
 */

const failure = <const Code extends string>(code: Code) =>
  z.strictObject({ error: z.literal(code) });

const json = <Schema extends z.ZodType>(schema: Schema, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

const body = <Schema extends z.ZodType>(schema: Schema) => ({
  body: { content: { 'application/json': { schema } }, required: true },
});

const time = () => z.string().openapi({ format: 'date-time' });

const CHANGE_REFUSED = changeFailures[403].content['application/json'].schema.options;
const SWITCHED = callerFailures[409].content['application/json'].schema.options;

/** A change's own 403s, as one answer with those every change can get before it runs. */
const managersOnly = json(
  z.union([failure('not_allowed'), ...CHANGE_REFUSED]),
  'Only an owner or admin of the workspace may (`not_allowed`). Or: ' +
    changeFailures[403].description,
);

/** A route's own 409s, as one answer with `requireCaller`'s. */
const conflict = <const Own extends readonly z.ZodType[]>(description: string, ...own: Own) =>
  json(z.union([...own, ...SWITCHED]), `${description} Or: ${callerFailures[409].description}`);

const notConfigured = json(
  failure('slack_not_configured'),
  'Slack is off on this server: it has no `CONNECTION_SECRETS_KEY` to seal Slack’s secrets with.',
);

const factoryNotFound = json(
  failure('factory_not_found'),
  'The workspace has no factory with that id that the caller sees: none, or one of a team a member is not in.',
);

const unsupportedMediaType = json(
  failure('unsupported_media_type'),
  'The body is not JSON (`Content-Type: application/json`).',
);

const FactoryId = z.string().openapi({ param: { name: 'factoryId', in: 'path' } });
const factoryParams = z.object({ factoryId: FactoryId });

// A factory's Slack app.

export const SlackManifest = z
  .strictObject({
    display_information: z.strictObject({ name: z.string() }),
    features: z.strictObject({
      app_home: z.strictObject({
        home_tab_enabled: z.literal(false),
        messages_tab_enabled: z.literal(true),
        messages_tab_read_only_enabled: z.literal(false),
      }),
      bot_user: z.strictObject({ display_name: z.string(), always_online: z.literal(false) }),
    }),
    oauth_config: z.strictObject({
      redirect_urls: z.array(z.string()),
      scopes: z.strictObject({ bot: z.array(z.enum(SLACK_BOT_SCOPES)) }),
    }),
    settings: z.strictObject({
      event_subscriptions: z.strictObject({
        request_url: z.string(),
        bot_events: z.array(z.enum(SLACK_BOT_EVENTS)),
      }),
      org_deploy_enabled: z.literal(false),
      socket_mode_enabled: z.literal(false),
      token_rotation_enabled: z.literal(false),
    }),
  })
  .openapi('SlackManifest', {
    description:
      'The manifest the factory’s app is created from, in Slack’s format: named after the ' +
      'factory, its bot’s handle the factory’s name as a slug.',
  });

export const SlackTeam = z
  .strictObject({ id: z.string(), name: z.string() })
  .openapi('SlackTeam', { description: 'A Slack workspace: its id (`T…`) and its name.' });

export const SlackAppStatus = z
  .strictObject({
    canManage: z.boolean().openapi({
      description:
        'Whether the person may set the app up, change it and disconnect it: an owner or admin.',
    }),
    state: z.enum(SLACK_APP_STATES).openapi({
      description:
        '`not_set_up`: no credentials yet; `awaiting_install`: saved, not added to Slack yet; ' +
        '`installed`; `needs_reinstall`: Slack refused the bot token, so the app has to be added again.',
    }),
    handle: z.string().openapi({
      description:
        'The bot’s handle, without the `@`: as Slack said it at the install, else the manifest’s.',
    }),
    clientId: z.union([z.string(), z.null()]).openapi({
      description: 'The app’s client ID, once saved. Never a secret: no secret is ever answered.',
    }),
    appId: z.union([z.string(), z.null()]),
    appSettingsUrl: z.union([z.string(), z.null()]).openapi({
      description: 'The app’s page in Slack, once installed: where it is renamed and deleted.',
    }),
    team: z.union([SlackTeam, z.null()]),
    installedAt: z.union([time(), z.null()]),
    setup: z.strictObject({
      manifest: SlackManifest,
      createAppUrl: z.string().openapi({
        description: 'Slack’s “create an app from a manifest” page, with the manifest filled in.',
      }),
      requestUrl: z.string().openapi({ description: 'Where Slack sends the app’s events.' }),
      redirectUrl: z
        .string()
        .openapi({ description: 'Where Slack sends a person back after “Add to Slack”.' }),
    }),
  })
  .openapi('SlackAppStatus', { description: 'A factory’s Slack app, and how to set it up.' });

export const getFactorySlack = createRoute({
  method: 'get',
  path: '/api/factories/{factoryId}/slack',
  summary: 'A factory’s Slack app',
  description:
    'Where the factory’s Slack app stands, its handle and Slack workspace, and the manifest and ' +
    'addresses it is set up with. Any member who sees the factory may read it.',
  request: { params: factoryParams },
  responses: {
    ...callerFailures,
    200: json(SlackAppStatus, 'The factory’s Slack app.'),
    404: factoryNotFound,
    503: notConfigured,
  },
});

export const SlackCredentials = z
  .object({
    clientId: z.string(),
    clientSecret: z.string(),
    signingSecret: z.string(),
  })
  .openapi('SlackCredentials', {
    description: 'From the app’s Basic Information page in Slack, under App Credentials.',
  });

export const putFactorySlackCredentials = createRoute({
  method: 'put',
  path: '/api/factories/{factoryId}/slack/credentials',
  summary: 'Save a factory’s Slack app credentials',
  description:
    'The app’s client ID, client secret and signing secret. The secrets are sealed before they ' +
    'are stored, and never answered. Saved with the client ID the app already has, an install ' +
    'stays; with another, it is forgotten. Only an owner or admin may.',
  request: { params: factoryParams, ...body(SlackCredentials) },
  responses: {
    ...changeFailures,
    200: json(SlackAppStatus, 'Saved: the factory’s Slack app now.'),
    400: json(
      z.union([
        z
          .strictObject({
            error: z.literal('invalid_credentials'),
            problems: z.array(z.enum(SLACK_CREDENTIAL_PROBLEMS)),
          })
          .openapi('InvalidSlackCredentials'),
        failure('invalid_request'),
      ]),
      'A credential is missing or not of the shape Slack gives it (`invalid_credentials`, each ' +
        `named). Or (\`invalid_request\`): ${callerFailures[400].description}`,
    ),
    403: managersOnly,
    404: factoryNotFound,
    415: unsupportedMediaType,
    503: notConfigured,
  },
});

export const postFactorySlackInstall = createRoute({
  method: 'post',
  path: '/api/factories/{factoryId}/slack/install',
  summary: 'Start adding a factory’s Slack app to Slack',
  description:
    'Slack’s authorise page for the factory’s app, carrying a state signed for this person and ' +
    'factory, for ten minutes. Only an owner or admin may. No cache keeps the answer ' +
    '(`Cache-Control: no-store`).',
  request: { params: factoryParams },
  responses: {
    ...changeFailures,
    200: json(
      z.strictObject({ url: z.string() }).openapi('SlackInstallAddress'),
      'Where to send the person.',
    ),
    403: managersOnly,
    404: factoryNotFound,
    409: conflict(
      'The factory’s app has no credentials yet (`credentials_missing`).',
      failure('credentials_missing'),
    ),
    503: notConfigured,
  },
});

export const deleteFactorySlack = createRoute({
  method: 'delete',
  path: '/api/factories/{factoryId}/slack',
  summary: 'Disconnect a factory’s Slack app',
  description:
    'Revokes the bot token, as far as Slack answers, and forgets everything Consola kept for ' +
    'the app: its credentials, its events, its links not used yet and its requests’ threads. ' +
    'The app itself stays in Slack, until someone deletes it there (`appSettingsUrl`). Only an ' +
    'owner or admin may.',
  request: { params: factoryParams },
  responses: {
    ...changeFailures,
    204: { description: 'Disconnected.' },
    403: managersOnly,
    404: json(
      z.union([failure('factory_not_found'), failure('slack_not_set_up')]),
      'The workspace has no such factory (`factory_not_found`), or it has no Slack app (`slack_not_set_up`).',
    ),
    503: notConfigured,
  },
});

/** How an "Add to Slack" ended, as the callback names it in the web app's `?slack=`. */
export const SLACK_CALLBACK_RESULTS = [
  'installed',
  'cancelled',
  'bad_state',
  'expired',
  'not_allowed',
  'factory_not_found',
  'credentials_missing',
  'credentials_changed',
  'code_refused',
  'not_a_bot',
  'enterprise_install',
  'app_taken',
  'wrong_app',
  'invalid',
  'unavailable',
  'not_configured',
] as const;

/**
 * The results, as a named schema of the document (`slack.ts` registers it), so a client's own
 * list of them is checked against the contract's, though no route answers one in a body.
 */
export const SlackCallbackResult = z.enum(SLACK_CALLBACK_RESULTS).openapi('SlackCallbackResult', {
  description: 'How an “Add to Slack” ended, as the callback names it in the web app’s `?slack=`.',
});

export const getSlackOAuthCallback = createRoute({
  method: 'get',
  path: SLACK_OAUTH_CALLBACK_PATH,
  summary: 'Where Slack sends a person back after “Add to Slack”',
  description:
    'Every factory’s Slack app’s redirect URL, reached by a browser redirect from Slack with ' +
    '`code` and `state`, or `error`. It needs no session: the signed state names the workspace, ' +
    'the factory and the person, so it works on the tunnel’s address too. It never answers ' +
    'JSON: it always redirects to the factory’s settings in the web app, with how it ended in ' +
    `\`?slack=\`: one of ${SLACK_CALLBACK_RESULTS.map((result) => `\`${result}\``).join(', ')}.`,
  responses: {
    302: {
      description:
        'To `<PUBLIC_URL>/?slack=<result>#/factories/<factoryId>/settings`, or, when the state ' +
        'names no factory, `<PUBLIC_URL>/?slack=<result>#/settings/connections`.',
      headers: z.object({ location: z.string() }),
    },
  },
});

// The Slack accounts people link to theirs.

const LinkToken = z.string().openapi({
  param: { name: 'token', in: 'path' },
  description: 'The token of a one-time link Consola sent in Slack.',
});
const LinkId = z.string().openapi({ param: { name: 'linkId', in: 'path' } });

const linkNotFound = json(failure('link_not_found'), 'No link has that token.');

export const SlackLinkRequestView = z
  .strictObject({
    state: z.enum(['open', 'used', 'expired']).openapi({
      description: 'A link works once (`used` after), for 15 minutes (`expired` after).',
    }),
    workspaceId: z.string().openapi({ description: 'The workspace the link links in.' }),
    inActiveWorkspace: z.boolean().openapi({
      description:
        'Whether that is the session’s active workspace. Only then can it be confirmed; ' +
        'otherwise the page offers to switch (`PUT /api/me/workspace`).',
    }),
    slackTeamId: z.string(),
    slackUserId: z.string(),
    slackTeamName: z.union([z.string(), z.null()]).openapi({
      description:
        'The Slack workspace’s name, as an app of the active workspace holds it; else null.',
    }),
    factory: z.union([z.strictObject({ id: z.string(), name: z.string() }), z.null()]).openapi({
      description:
        'The factory whose bot sent it, when the caller sees it in the active workspace; else null.',
    }),
    expiresAt: time(),
  })
  .openapi('SlackLinkRequest', { description: 'A one-time link, as its page shows it.' });

export const SlackLink = z
  .strictObject({
    id: z.string(),
    slackTeamId: z.string(),
    slackTeamName: z.union([z.string(), z.null()]).openapi({
      description: 'The Slack workspace’s name, as an app of the workspace holds it; else null.',
    }),
    slackUserId: z.string(),
    linkedAt: time(),
  })
  .openapi('SlackLink', {
    description:
      'A Slack account linked to the person in the active workspace. No Slack name is kept.',
  });

export const getSlackLinkRequest = createRoute({
  method: 'get',
  path: '/api/slack/link-requests/{token}',
  summary: 'A one-time link, as its page shows it',
  description:
    'What the link page shows before the person confirms: whether it still works, the Slack ' +
    'account it links, and whether it is for the session’s active workspace.',
  request: { params: z.object({ token: LinkToken }) },
  responses: {
    ...callerFailures,
    200: json(SlackLinkRequestView, 'The link.'),
    404: linkNotFound,
    503: notConfigured,
  },
});

export const postSlackLinkRequest = createRoute({
  method: 'post',
  path: '/api/slack/link-requests/{token}',
  summary: 'Confirm a one-time link',
  description:
    'Links the Slack account the link names to the person, in the session’s active workspace, ' +
    'which must be the link’s. The link works once. The bot then says so in Slack, as far as ' +
    'Slack answers.',
  request: { params: z.object({ token: LinkToken }) },
  responses: {
    ...changeFailures,
    200: json(SlackLink, 'Linked, or linked already to this person.'),
    404: linkNotFound,
    409: conflict(
      'The link was used already (`link_used`) or has expired (`link_expired`), is for another ' +
        'workspace than the session’s active one (`other_workspace`), or its Slack account is ' +
        'linked to someone else there (`linked_to_someone_else`).',
      failure('link_used'),
      failure('link_expired'),
      failure('other_workspace'),
      failure('linked_to_someone_else'),
    ),
    503: notConfigured,
  },
});

export const listSlackLinks = createRoute({
  method: 'get',
  path: '/api/slack/links',
  summary: 'My Slack accounts linked in my active workspace',
  responses: {
    ...callerFailures,
    200: json(
      z.strictObject({ links: z.array(SlackLink) }).openapi('SlackLinks'),
      'The person’s links, oldest first.',
    ),
    503: notConfigured,
  },
});

export const deleteSlackLink = createRoute({
  method: 'delete',
  path: '/api/slack/links/{linkId}',
  summary: 'Unlink one of my Slack accounts',
  description: 'A person removes only their own links, in the session’s active workspace.',
  request: { params: z.object({ linkId: LinkId }) },
  responses: {
    ...changeFailures,
    204: { description: 'Unlinked.' },
    404: json(
      failure('link_not_found'),
      'The person has no link with that id in the active workspace.',
    ),
    503: notConfigured,
  },
});
