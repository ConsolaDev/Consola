// What Slack's use cases need from the world outside, each implemented by an adapter: Slack's
// Web API (`adapters/slack`), the sealer of its secrets (`adapters/sealing`), the signer of an
// "Add to Slack" state, and the rows a workspace keeps about its Slack apps
// (`adapters/persistence`, `slackStores.ts`).

import type {
  Sealed,
  SlackInstall,
  SlackInstallState,
  SlackLinkRequest,
  SlackPersonLink,
  SlackPosted,
  SlackRequestThread,
  StoredSlackApp,
} from '../domain/slack.js';

/**
 * Seals the secrets Consola keeps for Slack (a client secret, a signing secret, a bot token)
 * before they are stored, and opens them when they are used. It never logs.
 */
export type SecretSealer = {
  /** The secret, sealed: what the database holds in its place. */
  seal(secret: string): Sealed;
  /** The secret, or null when the text is not one this sealer sealed (another key, or changed). */
  open(sealed: Sealed): string | null;
};

/** Signs an "Add to Slack" state, and reads one back only when this signer signed it. */
export type SlackInstallStateSigner = {
  sign(state: SlackInstallState): string;
  /** The state, or null when this signer did not sign it, or it is no state at all. */
  read(token: string): SlackInstallState | null;
};

/**
 * Makes the tokens of one-time links: unguessable, `SLACK_LINK_TOKEN_BYTES` random bytes, and the
 * hash each is kept as.
 */
export type LinkTokens = {
  /** A new token, as it goes in the link's address. */
  newToken(): string;
  /** What is kept of a token, and looked up by: its SHA-256, in hex. */
  hashOf(token: string): string;
};

export type { SlackInstallState };

// Slack's Web API.

/**
 * Why a Slack call did not do what it was asked: Slack answered `ok: false` with its error code
 * (`refused`), or it could not be asked or did not answer as Slack does (`unavailable`, with a
 * reason that holds no token).
 */
export type SlackError =
  | { kind: 'refused'; code: string }
  | { kind: 'unavailable'; reason: string };

/** A Slack call's answer: what Slack said, or why it did not. Never thrown. */
export type SlackAnswer<T> = { ok: true; value: T } | { ok: false; error: SlackError };

/** A Block Kit block, as far as Consola writes them. */
export type SlackBlock =
  /** Slack's `markdown` block: standard Markdown, which Slack renders. */
  | { type: 'markdown'; text: string }
  | { type: 'section'; text: { type: 'mrkdwn' | 'plain_text'; text: string } }
  | { type: 'context'; elements: Array<{ type: 'mrkdwn' | 'plain_text'; text: string }> };

/** What `oauth.v2.access` granted a bot when it was added to a Slack workspace. */
export type SlackOAuthGrant = {
  /** The bot token (`xoxb-…`). Sealed before it is stored, and never logged. */
  botToken: string;
  /** `bot`, for a bot token. */
  tokenType: string;
  /** The bot's scopes, as Slack granted them. */
  scopes: string[];
  appId: string;
  botUserId: string;
  team: { id: string; name: string };
  /** Whether it was installed on a whole Enterprise Grid org, not one workspace. */
  enterpriseInstall: boolean;
};

/** Who `auth.test` says a token is. */
export type SlackIdentity = {
  teamId: string;
  team: string;
  /** The token's user: the bot user, for a bot token. */
  userId: string;
  /** The user's name: the bot's handle, for a bot token. */
  user: string;
  /** The bot's id, for a bot token. */
  botId: string | null;
};

/**
 * The Slack Web API methods Consola calls, each with the token it is handed. A call Slack
 * refuses answers its error code; one it cannot make answers `unavailable`. No call logs a token
 * or a secret.
 */
export type SlackApi = {
  /** Exchanges an "Add to Slack" code for the bot's token, with the app's own credentials. */
  oauthAccess(request: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<SlackAnswer<SlackOAuthGrant>>;
  /** Revokes the token: the bot is gone from the Slack workspace until it is added again. */
  authRevoke(token: string): Promise<SlackAnswer<{ revoked: boolean }>>;
  /** Who the token is. */
  authTest(token: string): Promise<SlackAnswer<SlackIdentity>>;
  /** Posts a message in a channel, in a thread when `threadTs` names one. */
  postMessage(
    token: string,
    message: { channel: string; text: string; blocks?: SlackBlock[]; threadTs?: string },
  ): Promise<SlackAnswer<{ channel: string; ts: string }>>;
  /** Posts a message only `user` sees, in a channel they are in. */
  postEphemeral(
    token: string,
    message: {
      channel: string;
      user: string;
      text: string;
      blocks?: SlackBlock[];
      threadTs?: string;
    },
  ): Promise<SlackAnswer<{ messageTs: string }>>;
  /** Adds the reaction `name` (`eyes`, without colons) to a message. */
  addReaction(
    token: string,
    reaction: { channel: string; timestamp: string; name: string },
  ): Promise<SlackAnswer<null>>;
  /** A message's permalink. */
  getPermalink(
    token: string,
    message: { channel: string; messageTs: string },
  ): Promise<SlackAnswer<{ permalink: string }>>;
};

// The stores. Every call throws when the database does not answer.

/** What saving a factory's Slack credentials keeps of an install already there. */
export type SlackCredentials = {
  workspaceId: string;
  factoryId: string;
  clientId: string;
  clientSecret: Sealed;
  signingSecret: Sealed;
  /** The bot's handle, as the manifest gives it. */
  handle: string;
  configuredBy: string;
  at: Date;
};

/**
 * Each factory's Slack app. A factory has one at most. A factory of another workspace is one the
 * store does not have, but for `ofFactory`, which Slack's events use: they name a factory alone.
 */
export type SlackAppStore = {
  /** The factory's app, or null when it has none, or the workspace has no such factory. */
  get(workspaceId: string, factoryId: string): Promise<StoredSlackApp | null>;
  /** The factory's app, whichever workspace it is in: for Slack's events, which name a factory. */
  ofFactory(factoryId: string): Promise<StoredSlackApp | null>;
  /** The workspace's apps, in the order they were set up. */
  ofWorkspace(workspaceId: string): Promise<StoredSlackApp[]>;
  /**
   * Saves the factory's credentials, making its app if it has none. Saved with the client ID it
   * already has, an install stays; with another, the install is forgotten, since it was another
   * app's. `not-found` when the workspace has no such factory.
   */
  saveCredentials(credentials: SlackCredentials): Promise<'saved' | 'not-found'>;
  /**
   * Records an install on the factory's app, its bot token sealed, if the app still has the
   * client ID the install was made with (`credentials-changed` otherwise). It clears
   * `needs_reinstall`. `app-taken` when another factory's app has the app id, and then nothing
   * is written; `not-found` when the factory has no app.
   */
  install(entry: {
    workspaceId: string;
    factoryId: string;
    clientId: string;
    install: SlackInstall;
    botToken: Sealed;
    /** The bot's handle, as Slack says it now. */
    handle: string;
  }): Promise<'installed' | 'not-found' | 'credentials-changed' | 'app-taken'>;
  /**
   * Marks the factory's app as needing to be added to Slack again, when its install is still
   * the one for `appId`. False when nothing was marked.
   */
  markNeedsReinstall(ids: {
    workspaceId: string;
    factoryId: string;
    appId: string;
  }): Promise<boolean>;
  /**
   * Forgets the factory's app and everything kept for it (its events, its links not used yet and
   * its requests' threads), in one transaction, and answers what was forgotten, so its bot token
   * can be revoked. Null when there was nothing to forget.
   */
  forget(workspaceId: string, factoryId: string): Promise<StoredSlackApp | null>;
};

/** How confirming a one-time link ended. */
export type LinkConfirmation =
  | { kind: 'linked'; link: SlackPersonLink }
  /** The Slack account was already linked to this person: nothing changed but the link's use. */
  | { kind: 'already-linked'; link: SlackPersonLink }
  /** The Slack account is linked to someone else in the workspace: nothing changed. */
  | { kind: 'linked-to-another' }
  | { kind: 'used' }
  | { kind: 'expired' }
  | { kind: 'not-found' };

/** The Slack accounts people linked, and the one-time links Consola sent to link them. */
export type SlackLinkStore = {
  /** Records a one-time link, by its token's hash. */
  createRequest(request: SlackLinkRequest): Promise<void>;
  /** The link with that token's hash, or null. */
  findRequest(tokenHash: string): Promise<SlackLinkRequest | null>;
  /**
   * Uses the link, if it is still open at `at`, and links its Slack account to `personId` in
   * its workspace, in one transaction: the link is used only once, even by two at the same moment.
   */
  confirm(entry: { tokenHash: string; personId: string; at: Date }): Promise<LinkConfirmation>;
  /** The person a Slack account is linked to in the workspace, by their id, or null. */
  personOf(ids: {
    workspaceId: string;
    slackTeamId: string;
    slackUserId: string;
  }): Promise<string | null>;
  /** The person's links in the workspace, oldest first. */
  linksOf(workspaceId: string, personId: string): Promise<SlackPersonLink[]>;
  /** Removes one of the person's links in the workspace. False when they have no such link. */
  unlink(ids: { workspaceId: string; personId: string; linkId: string }): Promise<boolean>;
};

/** The events Slack sent each factory's app, kept by id so each is handled once. */
export type SlackEventStore = {
  /** Records the event, unless the factory has it already (`recorded-before`, nothing changes). */
  record(event: {
    workspaceId: string;
    factoryId: string;
    eventId: string;
    at: Date;
  }): Promise<'recorded' | 'recorded-before'>;
};

/** The Slack threads requests were started from, one per cloud session. */
export type SlackRequestStore = {
  /** Records the thread a request's session was started from. */
  record(thread: SlackRequestThread): Promise<void>;
  /** The thread a session was started from, or null when it was not started from Slack. */
  ofSession(sessionId: string): Promise<SlackRequestThread | null>;
  /** The requests a factory's app started in a thread, oldest first. */
  inThread(ids: {
    factoryId: string;
    channelId: string;
    threadTs: string;
  }): Promise<SlackRequestThread[]>;
  /**
   * Moves what Consola last posted in the session's thread from `expected` to `posted`, a
   * compare-and-set, so a state is posted once. False when it was not `expected`.
   */
  markPosted(
    sessionId: string,
    expected: SlackPosted | null,
    posted: SlackPosted,
  ): Promise<boolean>;
};
