import type { Caller } from '../domain/caller.js';
import {
  isDeadTokenError,
  isLinkTokenShape,
  linkRequestState,
  SLACK_LINK_LIFETIME_SECONDS,
  slackLinkUrl,
} from '../domain/slack.js';
import type { SlackPersonLink, StoredSlackApp } from '../domain/slack.js';
import { seenFactory } from './factories.js';
import type { Clock, FactoryStore, TeamStore } from './ports.js';
import type {
  LinkTokens,
  SecretSealer,
  SlackApi,
  SlackAppStore,
  SlackLinkStore,
} from './slackPorts.js';

/*
 * Linking a person's Slack account to their Consola account (CON-144). When someone who is not
 * linked yet writes to a factory's bot, Consola sends them, and only them, a one-time link to the
 * web app; they open it signed in and confirm it there.
 */

/** Who wrote to a factory's bot without a link: where, and as whom in Slack. */
export type UnlinkedWriter = {
  workspaceId: string;
  factoryId: string;
  slackTeamId: string;
  slackUserId: string;
  /** The channel they wrote in, where the bot answers once they are linked. */
  channelId: string;
};

/**
 * A one-time link for a Slack user who wrote to a factory's bot before linking: a new token of
 * `SLACK_LINK_TOKEN_BYTES` random bytes, kept only as its hash, which works once for
 * `SLACK_LINK_LIFETIME_SECONDS` (15 minutes) and names the workspace, the factory, the Slack
 * workspace, the Slack user and the channel. Answers the link's address in the web app
 * (`<PUBLIC_URL>/#/slack/link/<token>`), for the bot to send that user alone, and when it expires.
 * The token is in nothing else it answers, and nothing here logs it.
 */
export async function requestSlackLink(
  ports: { links: SlackLinkStore; tokens: LinkTokens; clock: Clock },
  writer: UnlinkedWriter,
  publicUrl: string,
): Promise<{ url: string; expiresAt: Date }> {
  const token = ports.tokens.newToken();
  const now = ports.clock.nowSeconds();
  const expiresAt = new Date((now + SLACK_LINK_LIFETIME_SECONDS) * 1000);
  await ports.links.createRequest({
    tokenHash: ports.tokens.hashOf(token),
    workspaceId: writer.workspaceId,
    factoryId: writer.factoryId,
    slackTeamId: writer.slackTeamId,
    slackUserId: writer.slackUserId,
    channelId: writer.channelId,
    createdAt: new Date(now * 1000),
    expiresAt,
    usedAt: null,
  });
  return { url: slackLinkUrl(publicUrl, token), expiresAt };
}

/**
 * Who a Slack user is in a workspace: the person their Slack account is linked to, by their id,
 * or null when it is linked to nobody there.
 */
export function linkedPersonOf(
  links: SlackLinkStore,
  slackUser: { workspaceId: string; slackTeamId: string; slackUserId: string },
): Promise<string | null> {
  return links.personOf(slackUser);
}

/** What the link pages need. */
export type SlackLinkPorts = {
  links: SlackLinkStore;
  apps: SlackAppStore;
  teams: TeamStore;
  factories: FactoryStore;
  tokens: LinkTokens;
  sealer: SecretSealer;
  slack: SlackApi;
  clock: Clock;
  /** Hears what failed on Slack's side, by ids alone, one line each. */
  report: (line: string) => void;
};

/** A one-time link, as its page shows it before the person confirms. */
export type SlackLinkView = {
  state: 'open' | 'used' | 'expired';
  workspaceId: string;
  inActiveWorkspace: boolean;
  slackTeamId: string;
  slackUserId: string;
  slackTeamName: string | null;
  factory: { id: string; name: string } | null;
  expiresAt: Date;
};

/** The name of a Slack workspace, as an app of the workspace holds it, or null. */
function teamNameOf(apps: readonly StoredSlackApp[], slackTeamId: string): string | null {
  return apps.find((app) => app.install?.teamId === slackTeamId)?.install?.teamName ?? null;
}

/** The link a token names, if it has a token's shape and the store has its hash. */
async function linkRequestOf(ports: Pick<SlackLinkPorts, 'links' | 'tokens'>, token: string) {
  if (!isLinkTokenShape(token)) return null;
  const tokenHash = ports.tokens.hashOf(token);
  const request = await ports.links.findRequest(tokenHash);
  return request ? { tokenHash, request } : null;
}

/**
 * A one-time link, as its page shows it: whether it still works, the Slack account it links, and
 * whether it is for the caller's active workspace. Only then are the Slack workspace's name and
 * the factory named, the factory only when the caller sees it.
 */
export async function viewSlackLink(
  ports: Pick<SlackLinkPorts, 'links' | 'apps' | 'teams' | 'factories' | 'tokens' | 'clock'>,
  caller: Caller,
  token: string,
): Promise<{ kind: 'found'; view: SlackLinkView } | { kind: 'not-found' }> {
  const found = await linkRequestOf(ports, token);
  if (!found) return { kind: 'not-found' };
  const { request } = found;
  const now = new Date(ports.clock.nowSeconds() * 1000);
  const inActiveWorkspace = request.workspaceId === caller.workspaceId;
  const factory = inActiveWorkspace
    ? await seenFactory(ports.teams, ports.factories, caller, request.factoryId)
    : null;
  const apps = inActiveWorkspace ? await ports.apps.ofWorkspace(caller.workspaceId) : [];
  return {
    kind: 'found',
    view: {
      state: linkRequestState(request, now),
      workspaceId: request.workspaceId,
      inActiveWorkspace,
      slackTeamId: request.slackTeamId,
      slackUserId: request.slackUserId,
      slackTeamName: teamNameOf(apps, request.slackTeamId),
      factory: factory ? { id: factory.id, name: factory.name } : null,
      expiresAt: request.expiresAt,
    },
  };
}

/** What the bot says once a person is linked, in the channel they wrote in. */
export const LINKED_MESSAGE = "You're linked. Send your request again.";

/**
 * Confirms a one-time link: links its Slack account to the caller, in the caller's active
 * workspace, which must be the link's (`other-workspace`). The link works once. Once linked, the
 * factory's bot says so where the person wrote, as far as Slack answers: in a DM, a message; in a
 * channel, one only they see. A bot token Slack says is dead marks the app as needing reinstalling.
 */
export async function confirmSlackLink(
  ports: SlackLinkPorts,
  caller: Caller,
  token: string,
): Promise<
  | { kind: 'linked'; link: NamedSlackLink }
  | { kind: 'not-found' }
  | { kind: 'used' }
  | { kind: 'expired' }
  | { kind: 'other-workspace' }
  | { kind: 'linked-to-another' }
> {
  const found = await linkRequestOf(ports, token);
  if (!found) return { kind: 'not-found' };
  const { tokenHash, request } = found;
  const now = new Date(ports.clock.nowSeconds() * 1000);
  const state = linkRequestState(request, now);
  if (state !== 'open') return { kind: state };
  if (request.workspaceId !== caller.workspaceId) return { kind: 'other-workspace' };

  const confirmed = await ports.links.confirm({ tokenHash, personId: caller.personId, at: now });
  if (confirmed.kind !== 'linked' && confirmed.kind !== 'already-linked') return confirmed;
  if (confirmed.kind === 'linked') await sayLinked(ports, request);
  const apps = await ports.apps.ofWorkspace(caller.workspaceId);
  const { link } = confirmed;
  return { kind: 'linked', link: { ...link, slackTeamName: teamNameOf(apps, link.slackTeamId) } };
}

/** Tells the person in Slack that they are linked, as far as Slack answers. Never throws. */
async function sayLinked(
  ports: Pick<SlackLinkPorts, 'apps' | 'sealer' | 'slack' | 'report'>,
  request: { workspaceId: string; factoryId: string; slackUserId: string; channelId: string },
): Promise<void> {
  const what = `factory ${request.factoryId} (workspace ${request.workspaceId})`;
  try {
    const app = await ports.apps.get(request.workspaceId, request.factoryId);
    const sealed = app?.sealed.botToken ?? null;
    const token = sealed === null ? null : ports.sealer.open(sealed);
    if (!app?.install || token === null) return;
    // A DM's channel is the bot's own with the person: a message there is theirs alone.
    const answer = request.channelId.startsWith('D')
      ? await ports.slack.postMessage(token, { channel: request.channelId, text: LINKED_MESSAGE })
      : await ports.slack.postEphemeral(token, {
          channel: request.channelId,
          user: request.slackUserId,
          text: LINKED_MESSAGE,
        });
    if (answer.ok) return;
    const { error } = answer;
    ports.report(
      `Could not tell Slack user ${request.slackUserId} they are linked, for ${what}: ${error.kind === 'refused' ? error.code : error.reason}.`,
    );
    if (error.kind === 'refused' && isDeadTokenError(error.code)) {
      await ports.apps.markNeedsReinstall({
        workspaceId: request.workspaceId,
        factoryId: request.factoryId,
        appId: app.install.appId,
      });
    }
  } catch {
    ports.report(
      `Could not tell a Slack user they are linked, for ${what}: the database did not answer.`,
    );
  }
}

/** A person's Slack link, with its Slack workspace's name as an app of the workspace holds it. */
export type NamedSlackLink = SlackPersonLink & { slackTeamName: string | null };

/** The caller's own Slack links in their active workspace, oldest first. */
export async function listMySlackLinks(
  ports: Pick<SlackLinkPorts, 'links' | 'apps'>,
  caller: Caller,
): Promise<NamedSlackLink[]> {
  const [links, apps] = await Promise.all([
    ports.links.linksOf(caller.workspaceId, caller.personId),
    ports.apps.ofWorkspace(caller.workspaceId),
  ]);
  return links.map((link) => ({ ...link, slackTeamName: teamNameOf(apps, link.slackTeamId) }));
}

/** Removes one of the caller's own Slack links in their active workspace. */
export async function unlinkSlack(
  ports: Pick<SlackLinkPorts, 'links'>,
  caller: Caller,
  linkId: string,
): Promise<{ kind: 'unlinked' } | { kind: 'not-found' }> {
  const removed = await ports.links.unlink({
    workspaceId: caller.workspaceId,
    personId: caller.personId,
    linkId,
  });
  return removed ? { kind: 'unlinked' } : { kind: 'not-found' };
}
