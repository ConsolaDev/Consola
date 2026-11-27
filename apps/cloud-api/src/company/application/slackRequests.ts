import { factoriesSeenBy } from '../domain/factory.js';
import { fromAnotherWorkspace, inThread, readSlackEvent } from '../domain/slackEvents.js';
import type { InstalledSlackApp, SlackEventCallback, SlackMessage } from '../domain/slackEvents.js';
import { WHO_MAY_TALK_WORDS } from '../domain/slackRequests.js';
import { botOf } from './slackBot.js';
import { whatFailed } from './slackEvents.js';
import type { Bot, BotPorts } from './slackBot.js';
import { linkedPersonOf, requestSlackLink } from './slackLinks.js';
import type { LinkTokens, SlackAppStore, SlackLinkStore, SlackRequestStore } from './slackPorts.js';
import type { AgentRunPorts, MembershipReader, TeamStore } from './ports.js';

/*
 * Requests from Slack (CON-144). A person mentions a factory's bot, or sends it a direct message,
 * and that starts a request for the factory's orchestrator, which Consola answers in the same
 * thread. Who may talk comes first: a linked member of the workspace who can see the factory.
 * Each refusal is a reply only that person sees.
 */

/** What handling Slack's events needs. */
export type SlackRequestPorts = AgentRunPorts &
  BotPorts & {
    apps: Pick<SlackAppStore, 'markNeedsReinstall'>;
    links: SlackLinkStore;
    requests: SlackRequestStore;
    tokens: LinkTokens;
    membership: MembershipReader;
    teams: TeamStore;
    /** The web app's address (`PUBLIC_URL`): where its links lead. */
    publicUrl: string;
  };

/** What became of one message to a factory's bot. */
export type SlackMessageOutcome =
  /** No message to take: a channel message, a bot's, an edit, a reaction. */
  | { kind: 'dropped'; reason: string }
  /** The bot cannot speak (its app needs adding to Slack again): nothing more is done. */
  | { kind: 'no-bot' }
  /** Refused, with a reply only the author sees. */
  | { kind: 'slack-connect' | 'link-sent' | 'not-a-member' | 'not-seen' | 'empty' }
  /** The factory is gone. */
  | { kind: 'factory-gone' }
  /** The author may talk to the factory, and asked for something. */
  | { kind: 'admitted'; personId: string };

/** Where a reply only the author sees goes: in their thread, or in the channel. */
function whisperTo(bot: Bot, message: SlackMessage, text: string): Promise<boolean> {
  return bot.whisper({
    channel: message.channelId,
    user: message.userId,
    ...(inThread(message) ? { threadTs: message.threadTs } : {}),
    text,
  });
}

/**
 * Whether the message's author may talk to the factory, in the design's order:
 *
 * 1. Slack Connect: an author of another Slack workspace than the app's is refused, with no link;
 * 2. no link: they get a one-time link to their Consola account (`requestSlackLink`), for them
 *    alone;
 * 3. no longer a member of the workspace, read live (`MembershipReader`);
 * 4. a member who cannot see the factory (`factoriesSeenBy`).
 *
 * Each refusal is a reply only the author sees, in plain words. A message with no text is
 * answered the same way, asking for one.
 */
export async function admitSlackMessage(
  ports: SlackRequestPorts,
  app: InstalledSlackApp,
  bot: Bot,
  message: SlackMessage,
): Promise<SlackMessageOutcome> {
  const { workspaceId, factoryId } = app;
  const about = `Slack user ${message.userId} of factory ${factoryId}`;
  const refuse = async (
    kind: 'slack-connect' | 'link-sent' | 'not-a-member' | 'not-seen' | 'empty',
    text: string,
  ) => {
    await whisperTo(bot, message, text);
    ports.report(`Did not take the message of ${about}: ${kind}.`);
    return { kind };
  };

  if (fromAnotherWorkspace(message, app.install.teamId)) {
    return refuse('slack-connect', WHO_MAY_TALK_WORDS.slackConnect);
  }
  const personId = await linkedPersonOf(ports.links, {
    workspaceId,
    slackTeamId: app.install.teamId,
    slackUserId: message.userId,
  });
  if (personId === null) {
    const { url } = await requestSlackLink(
      ports,
      {
        workspaceId,
        factoryId,
        slackTeamId: app.install.teamId,
        slackUserId: message.userId,
        channelId: message.channelId,
      },
      ports.publicUrl,
    );
    return refuse('link-sent', WHO_MAY_TALK_WORDS.link(url));
  }
  const role = await ports.membership.roleOf(personId, workspaceId);
  if (role === null) return refuse('not-a-member', WHO_MAY_TALK_WORDS.notAMember);

  const factory = await ports.factories.get(workspaceId, factoryId);
  if (factory === null) {
    ports.report(`Did not take the message of ${about}: the factory is gone.`);
    return { kind: 'factory-gone' };
  }
  const teams = await ports.teams.list(workspaceId);
  if (factoriesSeenBy({ personId, role }, teams, [factory]).length === 0) {
    return refuse('not-seen', WHO_MAY_TALK_WORDS.notSeen);
  }
  if (message.text === '') return refuse('empty', WHO_MAY_TALK_WORDS.empty);
  return { kind: 'admitted', personId };
}

/**
 * Handles one event a factory's app received, after Slack had its answer: a mention of the bot or
 * a direct message to it (`readSlackEvent`) whose author may talk to the factory
 * (`admitSlackMessage`). Anything else is dropped, and said in the log. Whatever fails is logged
 * with ids, never thrown: Slack has had its answer.
 */
export async function handleSlackEvent(
  ports: SlackRequestPorts,
  app: InstalledSlackApp,
  callback: SlackEventCallback,
): Promise<SlackMessageOutcome | { kind: 'failed' }> {
  const about = `Slack event ${callback.eventId} (${callback.eventType}) for factory ${app.factoryId}`;
  const read = readSlackEvent(callback.event, app.install.botUserId);
  if (read.kind === 'dropped') {
    ports.report(`Dropped ${about}: ${read.reason}.`);
    return read;
  }
  const bot = botOf(ports, app);
  if (bot === null) return { kind: 'no-bot' };
  try {
    return await admitSlackMessage(ports, app, bot, read.message);
  } catch (error) {
    ports.report(`Could not handle ${about}: ${whatFailed(error)}.`);
    return { kind: 'failed' };
  }
}
