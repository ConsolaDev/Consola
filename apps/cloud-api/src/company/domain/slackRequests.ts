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
import { AGENT_RUN_TITLE_MAX, agentRunError, standingOf } from './agentRun.js';
import type { CloudSession, SlackOrigin } from './cloudSession.js';
import { TITLE_MAX } from './run.js';
import { SLACK_LINK_LIFETIME_SECONDS } from './slack.js';
import type { SlackPosted } from './slack.js';
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
  /** No link yet, and one sent a moment ago is still open: the token cannot be sent again. */
  linkPending: `I sent you a link a moment ago; it works for ${SLACK_LINK_LIFETIME_SECONDS / 60} minutes. Open it, then send your request again.`,
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
  /** Something failed past the checks (the database did not answer). */
  somethingWentWrong: 'Something went wrong starting this request. Please try again.',
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

// Answering in the thread: once per state, as the session moves.

/** What Consola says in a request's thread as its run moves. */
export type SlackAnswer = {
  /** The message, as plain text: what notifications show, and all that shows without blocks. */
  readonly text: string;
  /** Slack's `markdown` block, for the orchestrator's summary. */
  readonly blocks?: ReadonlyArray<{ readonly type: 'markdown'; readonly text: string }>;
};

/** The most text Slack takes in its `markdown` blocks, all of them in one message together. */
export const SLACK_MARKDOWN_MAX = 12_000;

/** The longest `text` Consola sends: Slack splits a longer one into several messages. */
export const SLACK_TEXT_MAX = 4000;

/** How a cut summary ends. */
export const SUMMARY_CUT = '… the rest is in the run';

/** The longest error Consola quotes in a thread, in characters. */
const ERROR_MAX = 500;

/**
 * What Consola has to say in a request's thread for where its run stands: the first time it
 * waits on a person (`waiting`), when it finished (`done`), or when it failed or was cancelled
 * (`stopped`). Null while it is queued or working.
 */
export function slackStateOf(session: CloudSession): SlackPosted | null {
  switch (standingOf(session).status) {
    case 'waiting':
      return 'waiting';
    case 'completed':
      return 'done';
    case 'failed':
    case 'cancelled':
      return 'stopped';
    default:
      return null;
  }
}

/**
 * Whether Consola posts `state` in a thread where it last posted `posted`: each state once, a
 * question only before the run has ended, and nothing after an end.
 */
export function shouldPost(posted: SlackPosted | null, state: SlackPosted | null): boolean {
  if (state === null) return false;
  if (state === 'waiting') return posted === null;
  return posted === null || posted === 'waiting';
}

/**
 * Text from outside Consola (an agent's summary, a runner's message), with Slack's broadcasts
 * (`<!channel>`, `<!here>`, `<!everyone>`, a user group's `<!subteam^…>`) made plain words, so it
 * never notifies a whole channel. A mention of one person (`<@U…>`) stays.
 */
export function withoutBroadcasts(text: string): string {
  return text
    .replaceAll(/<!(channel|here|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replaceAll(/<!subteam\^[^>]*>/g, '@group');
}

/** `text` cut to `max` characters, at whole characters, ending `SUMMARY_CUT` when it is cut. */
function cutSummary(text: string, max: number): string {
  const characters = [...text];
  if (characters.length <= max) return text;
  // `SUMMARY_CUT` is one UTF-16 unit per character, so its length counts its characters.
  const kept = characters.slice(0, Math.max(0, max - SUMMARY_CUT.length)).join('');
  return `${kept.trimEnd()}${SUMMARY_CUT}`;
}

/** A sentence's words to follow a colon: its last full stop dropped, its first letter small. */
function afterColon(sentence: string): string {
  const one = sentence.replaceAll(/\s+/g, ' ').trim().replace(/[.]+$/, '');
  return /^[A-Z][a-z]/.test(one) ? `${one[0]?.toLowerCase()}${one.slice(1)}` : one;
}

/**
 * What Consola says in a request's thread for `state`, with the run's page (`runUrl`):
 *
 * - the first time it waits: "I need an answer to carry on: <link>";
 * - done: the orchestrator's summary in Slack's `markdown` block, and in plain text for
 *   notifications, each cut to Slack's limits and ending "… the rest is in the run", then the link;
 * - failed or cancelled: "The run stopped: <why, in words>. <link>".
 */
export function slackAnswerFor(
  state: SlackPosted,
  session: CloudSession,
  runUrl: string,
): SlackAnswer {
  if (state === 'waiting') return { text: `I need an answer to carry on: ${runUrl}` };
  if (state === 'stopped') {
    const error = agentRunError(session);
    const why =
      error === null
        ? 'it was stopped before it finished'
        : afterColon([...withoutBroadcasts(error)].slice(0, ERROR_MAX).join(''));
    return { text: `The run stopped: ${why}. ${runUrl}` };
  }
  const summary = withoutBroadcasts(session.agentRun?.summary?.trim() ?? '');
  if (summary === '') return { text: `Done. The run left no summary: ${runUrl}` };
  const link = `\n\n[Open the run in Consola](${runUrl})`;
  const plainLink = `\n\n${runUrl}`;
  return {
    text: `${cutSummary(summary, SLACK_TEXT_MAX - plainLink.length)}${plainLink}`,
    blocks: [
      {
        type: 'markdown',
        text: `${cutSummary(summary, SLACK_MARKDOWN_MAX - [...link].length)}${link}`,
      },
    ],
  };
}
