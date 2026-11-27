import type { components } from './apiContract';
import type { MeState } from './me';
import type { Refusal } from './refusal';
import type { MyWorkspace } from './workspace';

/*
 * Slack as a connection (CON-144), as the web app sees it. Each factory has a Slack app of its
 * own, with its own `@handle`: an owner or admin creates it in Slack from the factory's manifest,
 * pastes its three credentials into the factory's settings, then adds it to Slack, which sends
 * the bot token to Consola. People mention the bot, or message it, to send the factory's
 * orchestrator a request; the first time, the bot sends them a one-time link to this app, which
 * links their Slack account to them in the workspace (`#/slack/link/<token>`).
 *
 * The API decides everything (`apps/cloud-api/AGENTS.md`, its Slack routes): who may set an app
 * up (`canManage`), the app's state, whether a link still works and whether it is for the
 * session's active workspace. The page shows what it answers, and checks only what it would send.
 */

type Schemas = components['schemas'];

/** A factory's Slack app, and how to set it up: never a secret. */
export type SlackApp = Schemas['SlackAppStatus'];
export type SlackAppState = SlackApp['state'];
export type SlackCredentials = Schemas['SlackCredentials'];
/** A one-time link, as its page shows it before the person confirms it. */
export type SlackLinkRequest = Schemas['SlackLinkRequest'];
/** One of the person's Slack accounts, linked to them in the workspace. */
export type SlackLink = Schemas['SlackLink'];
/** How "Add to Slack" ended, as the API's callback names it in `?slack=`. */
export type SlackResult = Schemas['SlackCallbackResult'];
/** What the API, or the page, finds wrong with the credentials. */
export type SlackCredentialsProblem = Schemas['InvalidSlackCredentials']['problems'][number];

/** Every state an app can be in, in the order its setup goes through them. */
export const SLACK_APP_STATES = [
  'not_set_up',
  'awaiting_install',
  'installed',
  'needs_reinstall',
] as const satisfies readonly SlackAppState[];

export function isSlackAppState(value: unknown): value is SlackAppState {
  return typeof value === 'string' && (SLACK_APP_STATES as readonly string[]).includes(value);
}

/** Whether the app is in Slack: installed, or installed with a token Slack no longer accepts. */
export function isInstalled(app: Pick<SlackApp, 'state'>): boolean {
  return app.state === 'installed' || app.state === 'needs_reinstall';
}

/** The three steps of setting an app up, in their order. */
export const SLACK_STEPS = ['create', 'credentials', 'install'] as const;
export type SlackStepId = (typeof SLACK_STEPS)[number];

/**
 * Where a step stands: `done`, the one to do now (`current`), one that can be done now too since
 * the page cannot see it is next (`next`: the credentials, which the page cannot tell were made
 * in Slack), or one that waits for those before it (`waiting`).
 */
export type SlackStepStatus = 'done' | 'current' | 'next' | 'waiting';
export type SlackStep = { id: SlackStepId; status: SlackStepStatus };

/**
 * The setup's steps for an app that is not in Slack yet, or null for one that is, which shows
 * the app instead. Before anything is pasted, the app is made in Slack, then its credentials
 * pasted, which the page cannot tell apart, so both are open; Add to Slack waits for the
 * credentials. Once they are saved, only Add to Slack is left.
 */
export function slackSteps(app: Pick<SlackApp, 'state'>): SlackStep[] | null {
  switch (app.state) {
    case 'not_set_up':
      return [
        { id: 'create', status: 'current' },
        { id: 'credentials', status: 'next' },
        { id: 'install', status: 'waiting' },
      ];
    case 'awaiting_install':
      return [
        { id: 'create', status: 'done' },
        { id: 'credentials', status: 'done' },
        { id: 'install', status: 'current' },
      ];
    default:
      return null;
  }
}

export type SlackCredentialsField = keyof SlackCredentials;

/** Which field each problem is about; every problem the contract names has one. */
export const FIELD_OF_PROBLEM: Record<SlackCredentialsProblem, SlackCredentialsField> = {
  client_id_missing: 'clientId',
  client_id_invalid: 'clientId',
  client_secret_missing: 'clientSecret',
  client_secret_invalid: 'clientSecret',
  signing_secret_missing: 'signingSecret',
  signing_secret_invalid: 'signingSecret',
};

export function isCredentialsProblem(value: unknown): value is SlackCredentialsProblem {
  return typeof value === 'string' && Object.hasOwn(FIELD_OF_PROBLEM, value);
}

/**
 * The API's rules for the credentials (`checkSlackCredentials` in `cloud-api`'s Slack domain),
 * copied to check them before sending: a Client ID is two runs of digits joined by a dot; a
 * secret is letters and digits, 16 to 128 of them. The API checks again and is the authority.
 */
const CLIENT_ID = /^[0-9]{1,32}\.[0-9]{1,32}$/;
const SECRET = /^[A-Za-z0-9]{16,128}$/;

/**
 * The credentials as they are sent, trimmed, or what is wrong with them: a field left empty, the
 * App ID pasted for the Client ID, a secret pasted with something else.
 */
export function checkSlackCredentials(
  draft: SlackCredentials,
):
  | { ok: true; credentials: SlackCredentials }
  | { ok: false; problems: SlackCredentialsProblem[] } {
  const clientId = draft.clientId.trim();
  const clientSecret = draft.clientSecret.trim();
  const signingSecret = draft.signingSecret.trim();
  const problems: SlackCredentialsProblem[] = [];
  if (clientId === '') problems.push('client_id_missing');
  else if (!CLIENT_ID.test(clientId)) problems.push('client_id_invalid');
  if (clientSecret === '') problems.push('client_secret_missing');
  else if (!SECRET.test(clientSecret)) problems.push('client_secret_invalid');
  if (signingSecret === '') problems.push('signing_secret_missing');
  else if (!SECRET.test(signingSecret)) problems.push('signing_secret_invalid');
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, credentials: { clientId, clientSecret, signingSecret } };
}

/**
 * Whether an address is Slack's own, on `https:`: the create-app page (`api.slack.com`), the
 * authorise page (`slack.com`) and a message's permalink (`<team>.slack.com`). Only such an
 * address is somewhere the page sends the person.
 */
export function isSlackAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))
    );
  } catch {
    return false;
  }
}

/** What a person types in a channel to let the bot listen there. */
export function inviteCommand(handle: string): string {
  return `/invite @${handle}`;
}

/** Where Slack lists a person's apps, where an app is deleted. */
export const SLACK_APPS_URL = 'https://api.slack.com/apps';

/**
 * Where the app is deleted in Slack: its own page once the API knows it (`appSettingsUrl`), else
 * the list of the person's apps. Only Slack's own address.
 */
export function slackAppPageUrl(app: Pick<SlackApp, 'appSettingsUrl'>): string {
  const url = app.appSettingsUrl;
  return url !== null && isSlackAddress(url) ? url : SLACK_APPS_URL;
}

/** The manifest as a person pastes it into Slack's "From a manifest", indented. */
export function manifestText(app: Pick<SlackApp, 'setup'>): string {
  return JSON.stringify(app.setup.manifest, null, 2);
}

/** Every result the callback names, in the contract's order (`SlackCallbackResult`). */
export const SLACK_RESULTS = [
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
] as const satisfies readonly SlackResult[];

/** The result `?slack=` names, `unknown` for one this page does not know, null for none. */
export function readSlackResult(value: string | null): SlackResult | 'unknown' | null {
  if (value === null) return null;
  return (SLACK_RESULTS as readonly string[]).includes(value) ? (value as SlackResult) : 'unknown';
}

/**
 * The hash of a one-time link page: `#/slack/link/<token>`, the address the bot sends in Slack
 * (`<PUBLIC_URL>/#/slack/link/<token>`). Whatever follows the token (`/…` or `?…`) is ignored.
 */
const LINK_HASH = /^#\/slack\/link\/([^/?]+)(?:[/?].*)?$/s;

/**
 * The token a link page's hash names, or null for any other hash. A token that cannot be decoded
 * is no token: the page is then the app's own.
 */
export function slackLinkTokenOfHash(hash: string): string | null {
  const match = LINK_HASH.exec(hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** The hash of the link page for `token`. */
export function hashOfSlackLink(token: string): string {
  return `#/slack/link/${encodeURIComponent(token)}`;
}

/** How a page names a Slack workspace: its name, else its id. */
export function slackTeamLabel(team: { id: string; name: string | null }): string {
  return team.name ?? team.id;
}

// ---- What the API answers ----

/**
 * Slack is off on the server: it has no key to seal Slack's secrets with, and every Slack route
 * says so (503 `slack_not_configured`).
 */
export type NotConfigured = { kind: 'not-configured' };

/** Reading a factory's Slack app. */
export type SlackAppAnswer =
  | { kind: 'found'; app: SlackApp }
  /** The factory is gone, or another team's now. */
  | { kind: 'not-found' }
  | NotConfigured
  | Refusal;

/** Saving an app's credentials. */
export type SlackCredentialsAnswer =
  | { kind: 'saved'; app: SlackApp }
  | { kind: 'invalid'; problems: SlackCredentialsProblem[] }
  | { kind: 'not-allowed' }
  | { kind: 'not-found' }
  | NotConfigured
  | Refusal;

/** Starting "Add to Slack": Slack's authorise page to send the person to. */
export type SlackInstallAnswer =
  | { kind: 'started'; url: string }
  /** No credentials are saved for the app, so there is nothing to add. */
  | { kind: 'no-credentials' }
  | { kind: 'not-allowed' }
  | { kind: 'not-found' }
  | NotConfigured
  | Refusal;

/** Disconnecting the app: the token revoked and everything Consola kept for it forgotten. */
export type SlackDisconnectAnswer =
  | { kind: 'disconnected' }
  | { kind: 'not-allowed' }
  /** The factory is gone, or has no app any more. */
  | { kind: 'not-found' }
  | NotConfigured
  | Refusal;

/** Reading a one-time link, for the workspace the session has open. */
export type LinkRequestAnswer =
  | { kind: 'found'; request: SlackLinkRequest }
  /** No link has that token. */
  | { kind: 'not-found' }
  | NotConfigured
  | Refusal;

/** Why a link no longer works: used already, expired, or never a link. */
export type GoneWhy = 'used' | 'expired' | 'not-found';

/** Confirming a one-time link. */
export type ConfirmLinkAnswer =
  | { kind: 'linked'; link: SlackLink }
  | { kind: 'gone'; why: GoneWhy }
  /** The link is for another workspace than the session's active one. */
  | { kind: 'other-workspace' }
  /** The Slack account is linked to someone else in the workspace. */
  | { kind: 'taken' }
  | NotConfigured
  | Refusal;

/** The person's own Slack accounts in the workspace. */
export type SlackLinksAnswer = { kind: 'listed'; links: SlackLink[] } | NotConfigured | Refusal;

export type UnlinkAnswer = { kind: 'unlinked' } | { kind: 'not-found' } | NotConfigured | Refusal;

/** A factory the person sees, with its Slack app: what Connections lists. */
export type FactorySlackApp = { factory: { id: string; name: string }; app: SlackApp };

/** What Settings › Connections shows of Slack. */
export type SlackConnectionsAnswer =
  | {
      kind: 'listed';
      /** The factories with an app, set up or installed, in the API's order of factories. */
      apps: FactorySlackApp[];
      /** How many factories the person sees, with an app or not. */
      factoryCount: number;
      /** Whether the person may set an app up: an owner or an admin. */
      canManage: boolean;
      links: SlackLink[];
    }
  | NotConfigured
  | Refusal;

/** Whether Slack counts as connected on Connections: an app set up, or an account linked. */
export function slackConnected(answer: SlackConnectionsAnswer): boolean {
  return answer.kind === 'listed' && (answer.apps.length > 0 || answer.links.length > 0);
}

// ---- The link page ----

/** A workspace as the link page names it. */
type Named = { id: string; name: string };

/**
 * What the one-time link page shows, from who is signed in, their workspaces, what the link
 * says, and whether it was confirmed. A link confirmed is `linked` whatever else changed.
 */
export type LinkPageView =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' }
  | NotConfigured
  /** The session's workspace changed under the page: another tab switched it. */
  | { kind: 'switched' }
  /** Signed in with no workspace open, so the link cannot be read: one has to be opened first. */
  | { kind: 'no-workspace' }
  | { kind: 'gone'; why: GoneWhy; request: SlackLinkRequest | null }
  /** The link is for a workspace the person's list does not hold: not one of theirs. */
  | { kind: 'not-a-member'; request: SlackLinkRequest }
  /** The link is for another of the person's workspaces than the one open: offer to switch. */
  | {
      kind: 'other-workspace';
      request: SlackLinkRequest;
      /** The link's workspace, to switch to by its id; its name null while the list is unread. */
      target: { id: string; name: string | null };
      active: Named;
    }
  | { kind: 'confirm'; request: SlackLinkRequest; workspace: Named }
  | { kind: 'linked'; request: SlackLinkRequest; workspace: Named };

export function linkPageView({
  me,
  workspaces,
  read,
  linked,
}: {
  me: MeState | null;
  /** The person's workspaces, null while unknown or unlisted. */
  workspaces: readonly MyWorkspace[] | null;
  read: LinkRequestAnswer | null;
  linked: boolean;
}): LinkPageView {
  if (me === null) return { kind: 'loading' };
  if (me.kind !== 'signed-in') return { kind: me.kind };
  const active = me.me.workspace;
  if (active === null) return { kind: 'no-workspace' };
  if (read === null) return { kind: 'loading' };
  if (read.kind === 'not-found') return { kind: 'gone', why: 'not-found', request: null };
  if (read.kind !== 'found') return { kind: read.kind };
  const { request } = read;
  const workspace = { id: active.id, name: active.name };
  if (linked) return { kind: 'linked', request, workspace };
  if (request.state !== 'open') return { kind: 'gone', why: request.state, request };
  if (request.inActiveWorkspace) return { kind: 'confirm', request, workspace };
  // A link for a workspace the person's list does not hold is one they are not a member of.
  // With no list to tell, the switch is offered, and the API refuses it if they are not.
  const target =
    workspaces === null
      ? { id: request.workspaceId, name: null }
      : workspaces.find((one) => one.id === request.workspaceId);
  if (!target) return { kind: 'not-a-member', request };
  return {
    kind: 'other-workspace',
    request,
    target: { id: target.id, name: target.name },
    active: workspace,
  };
}
