// Slack as a connection (CON-144): each factory has a Slack app of its own, which a workspace's
// owners and admins create from Consola's manifest, give Consola the credentials of, and add to
// their Slack workspace. People link their Slack account to their Consola account once, and a
// mention or a DM of the factory's bot then starts a request for its orchestrator.
//
// "Cloud · Design: Slack as a Connection (CON-144)",
// https://linear.app/consola/document/cloud-design-slack-as-a-connection-con-144-b235f62bdf94

/**
 * Text a `SecretSealer` sealed: what the database holds in place of a secret. Only the sealer
 * makes one, so a secret in the clear never type-checks where a sealed one is stored.
 */
export type Sealed = string & { readonly __sealed: unique symbol };

/** Where a factory's Slack app stands, as its settings show it. */
export const SLACK_APP_STATES = [
  /** No credentials yet: the app may exist in Slack, but Consola knows nothing of it. */
  'not_set_up',
  /** The credentials are saved, and nobody has pressed "Add to Slack" yet. */
  'awaiting_install',
  /** Added to a Slack workspace: Consola holds its bot token. */
  'installed',
  /** Slack said the bot token is no longer good (revoked, the app uninstalled): add it again. */
  'needs_reinstall',
] as const;
export type SlackAppState = (typeof SLACK_APP_STATES)[number];

/** What an install added: the Slack app, the Slack workspace (team) and the bot it made there. */
export type SlackInstall = {
  /** The app's id in Slack (`A…`). */
  readonly appId: string;
  /** The Slack workspace's id (`T…`). */
  readonly teamId: string;
  /** The Slack workspace's name, as its admins named it. */
  readonly teamName: string;
  /** The bot's user id in that Slack workspace (`U…`). */
  readonly botUserId: string;
  /** Who pressed "Add to Slack", by their id. */
  readonly installedBy: string;
  readonly installedAt: Date;
};

/** A factory's Slack app, as Consola holds it, without its secrets. */
export type SlackApp = {
  readonly workspaceId: string;
  readonly factoryId: string;
  /** The app's client ID, from its Basic Information page. Not a secret. */
  readonly clientId: string;
  /** The bot's handle, without the `@`. */
  readonly handle: string;
  /** Who saved the credentials, by their id, and when. */
  readonly configuredBy: string;
  readonly configuredAt: Date;
  /** Null until "Add to Slack" finished. */
  readonly install: SlackInstall | null;
  /** Slack refused the bot token: the app has to be added to Slack again. */
  readonly needsReinstall: boolean;
};

/** A factory's Slack app with its secrets, each sealed, as the store holds them. */
export type StoredSlackApp = SlackApp & {
  readonly sealed: {
    readonly clientSecret: Sealed;
    readonly signingSecret: Sealed;
    /** Null until "Add to Slack" finished. */
    readonly botToken: Sealed | null;
  };
};

/** Where a factory's Slack app stands: none held is `not_set_up`. */
export function slackAppState(app: SlackApp | null): SlackAppState {
  if (app === null) return 'not_set_up';
  if (app.install === null) return 'awaiting_install';
  return app.needsReinstall ? 'needs_reinstall' : 'installed';
}

// The addresses Slack reaches, on the API's public address (a tunnel in development).

/** Where Slack sends a factory's events (its Events API request URL), under this prefix. */
export const SLACK_EVENTS_PATH_PREFIX = '/api/slack/events/';

/** The path Slack's events for `factoryId` are sent to. */
export function slackEventsPath(factoryId: string): string {
  return `${SLACK_EVENTS_PATH_PREFIX}${encodeURIComponent(factoryId)}`;
}

/** Where Slack sends a person back after "Add to Slack": every factory's app's redirect URL. */
export const SLACK_OAUTH_CALLBACK_PATH = '/api/slack/oauth/callback';

/**
 * The Slack Web API errors that say a token is no good any more: the app was uninstalled, the
 * token revoked, or the workspace or bot is gone. A factory whose bot token gets one needs
 * reinstalling.
 */
export const SLACK_TOKEN_DEAD_ERRORS = [
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'team_disabled',
] as const;

/** Whether a Slack error code says the token it was sent with is no good any more. */
export function isDeadTokenError(code: string): boolean {
  return (SLACK_TOKEN_DEAD_ERRORS as readonly string[]).includes(code);
}

// Linking a person's Slack account to their Consola account.

/** How long a link Consola sends a Slack user lasts, in seconds. */
export const SLACK_LINK_LIFETIME_SECONDS = 15 * 60;

/** How many random bytes a link's token holds. Only its hash is kept. */
export const SLACK_LINK_TOKEN_BYTES = 32;

/**
 * A one-time link Consola sent a Slack user who is not linked yet. It names the workspace, the
 * factory whose bot they wrote to, the Slack workspace (team), the Slack user and the channel they
 * wrote in. Its token is kept only as a hash.
 */
export type SlackLinkRequest = {
  readonly tokenHash: string;
  readonly workspaceId: string;
  readonly factoryId: string;
  readonly slackTeamId: string;
  readonly slackUserId: string;
  readonly channelId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** When it was used, or null while it is not. */
  readonly usedAt: Date | null;
};

/** Whether a link can still be used: once only, and only before it expires. */
export function linkRequestState(
  request: Pick<SlackLinkRequest, 'expiresAt' | 'usedAt'>,
  now: Date,
): 'open' | 'used' | 'expired' {
  if (request.usedAt !== null) return 'used';
  return now.getTime() >= request.expiresAt.getTime() ? 'expired' : 'open';
}

/**
 * A Slack account linked to a person, in one workspace: the Slack workspace (team) and user, and
 * the person's id. No Slack name or email is kept: those are a person's name and address.
 */
export type SlackPersonLink = {
  readonly id: string;
  readonly workspaceId: string;
  readonly slackTeamId: string;
  readonly slackUserId: string;
  readonly personId: string;
  readonly linkedAt: Date;
};

// Requests started from Slack.

/** What Consola last posted in a request's Slack thread, so it posts once per state. */
export type SlackPosted = 'waiting' | 'done' | 'stopped';

/**
 * The Slack thread a request was started from, recorded with its cloud session: where Consola
 * answers, and who started it (the linked person's id).
 */
export type SlackRequestThread = {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly factoryId: string;
  readonly slackTeamId: string;
  readonly channelId: string;
  /** The thread's root message (`thread_ts ?? ts` of the message that started it). */
  readonly threadTs: string;
  /** The message that started it. */
  readonly messageTs: string;
  readonly startedBy: string;
  /** What Consola last posted in the thread, or null before anything. */
  readonly posted: SlackPosted | null;
  readonly createdAt: Date;
};

// The credentials a factory's app is given, from its Basic Information page in Slack.

/** What can be wrong with the credentials pasted in, each named. */
export const SLACK_CREDENTIAL_PROBLEMS = [
  'client_id_missing',
  'client_id_invalid',
  'client_secret_missing',
  'client_secret_invalid',
  'signing_secret_missing',
  'signing_secret_invalid',
] as const;
export type SlackCredentialProblem = (typeof SLACK_CREDENTIAL_PROBLEMS)[number];

/** A Slack app's client ID: two runs of digits, joined by a dot (`1234567890.0987654321`). */
const CLIENT_ID = /^[0-9]{1,32}\.[0-9]{1,32}$/;
/** A Slack app's client secret or signing secret: letters and digits (32 hex digits today). */
const SECRET = /^[A-Za-z0-9]{16,128}$/;

/** The credentials as pasted, trimmed, or every problem with them. */
export function checkSlackCredentials(input: {
  clientId?: unknown;
  clientSecret?: unknown;
  signingSecret?: unknown;
}):
  | { ok: true; clientId: string; clientSecret: string; signingSecret: string }
  | { ok: false; problems: SlackCredentialProblem[] } {
  const problems: SlackCredentialProblem[] = [];
  const read = (
    value: unknown,
    pattern: RegExp,
    missing: SlackCredentialProblem,
    invalid: SlackCredentialProblem,
  ): string => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '') problems.push(missing);
    else if (!pattern.test(text)) problems.push(invalid);
    return text;
  };
  const clientId = read(input.clientId, CLIENT_ID, 'client_id_missing', 'client_id_invalid');
  const clientSecret = read(
    input.clientSecret,
    SECRET,
    'client_secret_missing',
    'client_secret_invalid',
  );
  const signingSecret = read(
    input.signingSecret,
    SECRET,
    'signing_secret_missing',
    'signing_secret_invalid',
  );
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, clientId, clientSecret, signingSecret };
}

// The manifest a factory's app is created from, in Slack's own format
// (https://docs.slack.dev/reference/app-manifest).

/** The longest name Slack gives an app. */
export const SLACK_APP_NAME_MAX = 35;

/** The longest display name Slack gives a bot. */
export const SLACK_HANDLE_MAX = 80;

/** The handle of a factory whose name has no letter or digit to make one of. */
const FALLBACK_HANDLE = 'factory';

/** The bot's scopes. Release 1 reads mentions and DMs; the rest wait for release 2's events. */
export const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'channels:read',
  'chat:write',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'mpim:history',
  'reactions:read',
  'reactions:write',
  'users:read',
] as const;

/** The bot events the app subscribes to, so that release 2 needs no reinstall. */
export const SLACK_BOT_EVENTS = [
  'app_mention',
  'message.im',
  'message.channels',
  'message.groups',
  'reaction_added',
  'member_joined_channel',
] as const;

/** A factory's app manifest, as Slack reads one. */
export type SlackManifest = {
  display_information: { name: string };
  features: {
    app_home: {
      home_tab_enabled: false;
      messages_tab_enabled: true;
      messages_tab_read_only_enabled: false;
    };
    bot_user: { display_name: string; always_online: false };
  };
  oauth_config: { redirect_urls: string[]; scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { request_url: string; bot_events: string[] };
    org_deploy_enabled: false;
    socket_mode_enabled: false;
    token_rotation_enabled: false;
  };
};

/** The factory's name, cut to what Slack takes as an app's name. */
export function slackAppName(factoryName: string): string {
  return [...factoryName.trim()].slice(0, SLACK_APP_NAME_MAX).join('').trim();
}

/**
 * The bot's handle for a factory: its name as a slug (`Code review` is `code-review`), letters
 * and digits joined by single dashes, accents dropped, cut to Slack's length.
 */
export function slackHandle(factoryName: string): string {
  const slug = factoryName
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, SLACK_HANDLE_MAX)
    .replace(/-+$/, '');
  return slug === '' ? FALLBACK_HANDLE : slug;
}

/**
 * The manifest a factory's app is created from: named after the factory, its bot's handle its
 * slug, with the scopes and bot events above, the Messages tab on, Slack's redirect to Consola's
 * callback and its events to the factory's own address, both on `slackPublicUrl` (the API's
 * public address). Socket Mode, org-wide deploy and token rotation are off.
 */
export function slackManifest(
  factory: { id: string; name: string },
  slackPublicUrl: string,
): SlackManifest {
  return {
    display_information: { name: slackAppName(factory.name) },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: slackHandle(factory.name), always_online: false },
    },
    oauth_config: {
      redirect_urls: [`${slackPublicUrl}${SLACK_OAUTH_CALLBACK_PATH}`],
      scopes: { bot: [...SLACK_BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: {
        request_url: `${slackPublicUrl}${slackEventsPath(factory.id)}`,
        bot_events: [...SLACK_BOT_EVENTS],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/** Slack's "create an app from a manifest" page, with the manifest filled in. */
export function createSlackAppUrl(manifest: SlackManifest): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

/** The app's page in Slack, where it is renamed, its credentials read, and it is deleted. */
export function slackAppSettingsUrl(appId: string): string {
  return `https://api.slack.com/apps/${encodeURIComponent(appId)}`;
}

/** Where the web app shows a one-time link, before its token. */
export const SLACK_LINK_PAGE_PATH = '/slack/link/';

/** The address of a one-time link's page in the web app. */
export function slackLinkUrl(publicUrl: string, token: string): string {
  return `${publicUrl}${SLACK_LINK_PAGE_PATH}${encodeURIComponent(token)}`;
}

/** A link's token as its address holds it: 32 bytes in base64url, with no padding. */
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Whether `value` has the shape of a link's token, so anything else is not looked up. */
export function isLinkTokenShape(value: string): boolean {
  return LINK_TOKEN.test(value);
}
