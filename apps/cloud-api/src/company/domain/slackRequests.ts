// Requests from Slack (CON-144, "Who may talk", "Starting a request"): what Consola says to the
// people who write to a factory's bot, and where its links lead in the web app.
//
// "Cloud · Design: Slack as a Connection (CON-144)",
// https://linear.app/consola/document/cloud-design-slack-as-a-connection-con-144-b235f62bdf94

import { SLACK_LINK_LIFETIME_SECONDS } from './slack.js';

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
