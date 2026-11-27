import { hasAgentTeam, parseAgentTeam } from '@consola/factory-spec';
import { FAILURE_WORDS } from '../domain/agentRun.js';
import { CELL_FAILURE_CODES } from '../domain/cloudSession.js';
import type { CellFailureCode, CloudSession } from '../domain/cloudSession.js';
import { factoriesSeenBy } from '../domain/factory.js';
import type { Factory } from '../domain/factory.js';
import { fromAnotherWorkspace, inThread, readSlackEvent } from '../domain/slackEvents.js';
import type { InstalledSlackApp, SlackEventCallback, SlackMessage } from '../domain/slackEvents.js';
import {
  factoryPageUrl,
  isOpenRequest,
  runPageUrl,
  SEEN_REACTION,
  slackOrigin,
  slackRequestStart,
  slackRequestTitle,
  START_WORDS,
  WHO_MAY_TALK_WORDS,
} from '../domain/slackRequests.js';
import { recordAgentRun } from './agentRuns.js';
import { handToRunner } from './cloudSessions.js';
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
  | { kind: 'admitted'; personId: string; factory: Factory }
  /** Not started, with a reply in the thread that says why. */
  | {
      kind:
        | 'no-orchestrator'
        | 'no-repository'
        | CellFailureCode
        | 'already-running'
        | 'no-permalink';
    }
  /**
   * Started: the session, its thread, its run, and the start handed to the runner. When the
   * runner could not be told, the session ended `failed`, and the thread hears so from the
   * session's follower.
   */
  | { kind: 'started'; session: CloudSession };

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
  return { kind: 'admitted', personId, factory };
}

/** When an agent run started, as its run records it: an ISO 8601 time. */
const ISO = (seconds: number) => new Date(seconds * 1000).toISOString();

/**
 * Starts a request from Slack for an admitted author, per the design's "Starting a request". The
 * checks come first, each refusal said in the thread in words, and nothing is recorded or sent:
 *
 * 1. the factory's latest files hold an agent team with no issues and an orchestrator;
 * 2. it lists a repository (`factory.yml`'s `repos:`), and the request works in the first;
 * 3. the workspace's runner offers that repository (in any case) and the orchestrator's harness
 *    (`claude` when it names none), in the words `startAgentRun` records;
 * 4. no request is open in the thread already (release 1 starts nothing more there);
 * 5. Slack gives the message's permalink, which the run names;
 * 6. the plan reads (`slackRequestStart`).
 *
 * Then the session is recorded (an agent run, `personId` null, its origin the message), the
 * thread with it (`slack_request`, which the session's row must hold first), and its run, a
 * request started by the author's person (`recordAgentRun`); the start is handed to the runner
 * (`handToRunner`); and, if it went, Consola reacts 👀 on the message and says in the thread where
 * to follow along. Its title is `<factory> · Slack: <first line>`.
 */
export async function startSlackRequest(
  ports: SlackRequestPorts,
  app: InstalledSlackApp,
  bot: Bot,
  message: SlackMessage,
  admitted: { personId: string; factory: Factory },
): Promise<SlackMessageOutcome> {
  const { workspaceId } = app;
  const { factory, personId } = admitted;
  const about = `the request of Slack user ${message.userId} to factory ${factory.id}`;
  const say = (text: string) =>
    bot.post({ channel: message.channelId, threadTs: message.threadTs, text });
  const decline = async (
    kind:
      | 'no-orchestrator'
      | 'no-repository'
      | CellFailureCode
      | 'already-running'
      | 'no-permalink',
    text: string,
  ) => {
    await say(text);
    ports.report(`Did not start ${about}: ${kind}.`);
    return { kind };
  };
  const factoryUrl = factoryPageUrl(ports.publicUrl, factory.id);

  const version = await ports.factories.version(workspaceId, factory.id, factory.latestVersion);
  const files = version?.files ?? [];
  const parsed = hasAgentTeam(files) ? parseAgentTeam(files) : null;
  const orchestrator = parsed?.team.orchestrator;
  if (parsed === null || parsed.issues.length > 0 || orchestrator === undefined) {
    return decline('no-orchestrator', START_WORDS.noOrchestrator(factoryUrl));
  }
  const { team } = parsed;
  const [wanted] = team.repositories;
  if (wanted === undefined) return decline('no-repository', START_WORDS.noRepository(factoryUrl));

  const harness = orchestrator.harness ?? 'claude';
  const refusedFor = (code: CellFailureCode) => decline(code, FAILURE_WORDS[code]);
  const offer = ports.runners.connected(workspaceId);
  if (!offer) return refusedFor(CELL_FAILURE_CODES.runnerUnavailable);
  const repository = offer.repositories.find(
    (offered) => offered.toLowerCase() === wanted.toLowerCase(),
  );
  if (repository === undefined) return refusedFor(CELL_FAILURE_CODES.repositoryNotOffered);
  if (!offer.harnesses.includes(harness)) return refusedFor(CELL_FAILURE_CODES.harnessNotOffered);

  for (const thread of await ports.requests.inThread({
    factoryId: factory.id,
    channelId: message.channelId,
    threadTs: message.threadTs,
  })) {
    const held = await ports.sessions.find(thread.sessionId);
    if (held !== null && isOpenRequest(held)) {
      return decline(
        'already-running',
        START_WORDS.alreadyRunning(runPageUrl(ports.publicUrl, held.id)),
      );
    }
  }

  const permalink = await bot.permalink({ channel: message.channelId, ts: message.ts });
  if (permalink === null) return decline('no-permalink', START_WORDS.noPermalink);

  const id = ports.ids.newId();
  const now = ports.clock.nowSeconds();
  const start = slackRequestStart(
    team,
    {
      kind: message.via,
      text: message.text,
      slackUserId: message.userId,
      channelId: message.channelId,
      permalink,
      repository,
    },
    id,
  );
  if (!start.ok) {
    ports.report(`Did not start ${about}: ${start.reason}`);
    return refusedFor(CELL_FAILURE_CODES.agentRunInvalid);
  }

  const session: CloudSession = {
    id,
    workspaceId,
    personId: null,
    repository,
    harness,
    status: 'starting',
    title: slackRequestTitle(factory.name, message.text),
    hostUrl: null,
    error: null,
    errorCode: null,
    runnerId: offer.runnerId,
    createdAt: now,
    endedAt: null,
    origin: slackOrigin(factory, orchestrator.name, {
      teamId: app.install.teamId,
      message,
      permalink,
    }),
    agentRun: null,
  };
  await ports.sessions.insert(session);
  await ports.requests.record({
    workspaceId,
    sessionId: id,
    factoryId: factory.id,
    slackTeamId: app.install.teamId,
    channelId: message.channelId,
    threadTs: message.threadTs,
    messageTs: message.ts,
    startedBy: personId,
    posted: null,
    createdAt: new Date(now * 1000),
  });
  await recordAgentRun(ports, session, {
    factoryVersion: factory.latestVersion,
    text: start.value.prompt,
    createdAt: ISO(now),
    startedBy: personId,
  });
  const held = await handToRunner(ports, session, offer.runnerId, { agentRun: start.value });
  ports.report(
    `Started ${about} as run ${id}${held.status === 'failed' ? ', which its runner could not be told of' : ''}.`,
  );
  if (held.status === 'failed') return { kind: 'started', session: held };

  await bot.react({ channel: message.channelId, ts: message.ts, name: SEEN_REACTION });
  await say(START_WORDS.onIt(runPageUrl(ports.publicUrl, id)));
  return { kind: 'started', session: held };
}

/**
 * Handles one event a factory's app received, after Slack had its answer: a mention of the bot or
 * a direct message to it (`readSlackEvent`) whose author may talk to the factory
 * (`admitSlackMessage`) starts a request for its orchestrator (`startSlackRequest`). Anything
 * else is dropped, and said in the log. Whatever fails is logged
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
    const admitted = await admitSlackMessage(ports, app, bot, read.message);
    if (admitted.kind !== 'admitted') return admitted;
    return await startSlackRequest(ports, app, bot, read.message, admitted);
  } catch (error) {
    ports.report(`Could not handle ${about}: ${whatFailed(error)}.`);
    return { kind: 'failed' };
  }
}
