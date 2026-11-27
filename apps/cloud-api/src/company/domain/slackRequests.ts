// Requests from Slack (CON-144, "Who may talk", "Starting a request"): what Consola says to the
// people who write to a factory's bot, and where its links lead in the web app.
//
// "Cloud · Design: Slack as a Connection (CON-144)",
// https://linear.app/consola/document/cloud-design-slack-as-a-connection-con-144-b235f62bdf94

import { planSlackRequest } from '@consola/factory-spec';
import type { AgentTeam, SlackRequest as PlannedSlackRequest } from '@consola/factory-spec';
import {
  AGENT_RUN_FACTORY_DIR,
  readAgentRun,
  SESSION_REPOSITORY_DIR,
} from '@consola/runner-protocol';
import type { AgentRun } from '@consola/runner-protocol';
import { AGENT_RUN_TITLE_MAX, standingOf } from './agentRun.js';
import type { CloudSession, SlackOrigin } from './cloudSession.js';
import { TITLE_MAX } from './run.js';
import { SLACK_LINK_LIFETIME_SECONDS } from './slack.js';
import { firstLineOf } from './slackEvents.js';
import type { SlackMessage } from './slackEvents.js';

/** A run's page in the web app (`#/runs/<id>`), on the web app's address (`PUBLIC_URL`). */
export function runPageUrl(publicUrl: string, runId: string): string {
  return `${publicUrl}/#/runs/${encodeURIComponent(runId)}`;
}

/** A factory's definition page in the web app (`#/factories/<id>/definition`). */
export function factoryPageUrl(publicUrl: string, factoryId: string): string {
  return `${publicUrl}/#/factories/${encodeURIComponent(factoryId)}/definition`;
}

/** What Consola tells the person who wrote, when it does not take their message. */
export const WHO_MAY_TALK_WORDS = {
  /** Slack Connect: the author belongs to another Slack workspace than the app's. */
  slackConnect:
    "I take requests only from people in this app's own Slack workspace, not from other organisations in a shared channel.",
  /** No link yet: the one-time link, for them alone. */
  link: (url: string) =>
    `Link your Slack account to Consola before I take your request: ${url}\nThe link is yours alone, works once and lasts ${SLACK_LINK_LIFETIME_SECONDS / 60} minutes. Then send your request again.`,
  /** Linked, but no longer a member of the workspace. */
  notAMember:
    "You're no longer a member of this factory's workspace in Consola, so I can't take your request.",
  /** A member who cannot see the factory. */
  notSeen:
    "You can't see this factory in Consola, so I can't take your request. An owner or admin of the workspace can add you to its team.",
  /** A mention or a message with nothing in it. */
  empty: "Tell me what you need in the same message, and I'll start on it.",
} as const;

/** What Consola says in the thread when it cannot start a request, or starts one. */
export const START_WORDS = {
  /** The factory's latest files hold no agent team with an orchestrator and no issues. */
  noOrchestrator: (factoryUrl: string) =>
    `This factory has no orchestrator in its files, so it can't take requests from Slack yet: ${factoryUrl}`,
  /** The factory's `factory.yml` lists no repository to work in. */
  noRepository: (factoryUrl: string) =>
    `This factory lists no repository to work in. Add one to \`repos:\` in its factory.yml: ${factoryUrl}`,
  /** A request is already open in this thread (release 2 makes this a follow-up). */
  alreadyRunning: (runUrl: string) => `This thread already has a request running: ${runUrl}`,
  /** Slack gave no permalink for the message, so the run could not name it. */
  noPermalink:
    "I couldn't read this message's link from Slack, so nothing started. Try again in a moment.",
  /** Started: the run's page in Consola. */
  onIt: (runUrl: string) => `On it. Follow along in Consola: ${runUrl}`,
} as const;

/** The emoji Consola reacts with on a message it took: 👀. */
export const SEEN_REACTION = 'eyes';

/** A control character: a line break, a tab, an escape. */
const CONTROL = /\p{Cc}+/gu;

/**
 * A request from Slack's title, which the app gives its session: `<factory> · Slack: <the
 * message's first line>`, on one line, cut to `AGENT_RUN_TITLE_MAX`, as an automation's is.
 */
export function slackRequestTitle(factoryName: string, text: string): string {
  const whole = `${factoryName} · Slack: ${firstLineOf(text, AGENT_RUN_TITLE_MAX)}`
    .replaceAll(CONTROL, ' ')
    .trim();
  const characters = [...whole];
  if (characters.length <= AGENT_RUN_TITLE_MAX) return whole;
  return `${characters
    .slice(0, AGENT_RUN_TITLE_MAX - 1)
    .join('')
    .trimEnd()}…`;
}

/** Where a request from Slack came from: the factory, its orchestrator, and the message. */
export function slackOrigin(
  factory: { id: string; name: string },
  agent: string,
  slack: { teamId: string; message: SlackMessage; permalink: string },
): SlackOrigin {
  const { message } = slack;
  return {
    kind: 'slack',
    factoryId: factory.id,
    factoryName: factory.name,
    agent,
    via: message.via,
    message: {
      teamId: slack.teamId,
      channelId: message.channelId,
      threadTs: message.threadTs,
      messageTs: message.ts,
      permalink: slack.permalink,
      title: firstLineOf(message.text, TITLE_MAX),
    },
  };
}

/**
 * The start the runner is handed for a request from Slack with id `runId`: factory-spec's plan
 * for the message (`planSlackRequest`), on the repository's default branch (no `checkout`), read
 * back with the protocol's reader so the app never sends what a runner would refuse. A plan that
 * cannot be made (no orchestrator) or that the reader refuses is `ok: false`, with the reason,
 * for the log.
 */
export function slackRequestStart(
  team: AgentTeam,
  request: PlannedSlackRequest,
  runId: string,
): { ok: true; value: AgentRun } | { ok: false; reason: string } {
  let plan: ReturnType<typeof planSlackRequest>;
  try {
    plan = planSlackRequest(team, request, {
      factoryDir: AGENT_RUN_FACTORY_DIR,
      repositoryDir: SESSION_REPOSITORY_DIR,
      runId,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `the run could not be planned: ${error instanceof Error ? error.message : 'an unexpected error'}`,
    };
  }
  const read = readAgentRun(plan);
  return read.ok
    ? { ok: true, value: read.value }
    : { ok: false, reason: `the protocol refuses the start: ${read.reason}` };
}

/** Whether an agent run is still open: queued, working, or waiting on a person. */
export function isOpenRequest(session: CloudSession): boolean {
  const { status } = standingOf(session);
  return status === 'queued' || status === 'running' || status === 'waiting';
}
