import { SLACK_LINK_LIFETIME_SECONDS, slackLinkUrl } from '../domain/slack.js';
import type { Clock } from './ports.js';
import type { LinkTokens, SlackLinkStore } from './slackPorts.js';

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
 * (`<PUBLIC_URL>/slack/link/<token>`), for the bot to send that user alone, and when it expires.
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
