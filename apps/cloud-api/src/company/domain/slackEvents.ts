// Slack's events for a factory's app (CON-144): what Slack sends to the factory's request URL
// (`slackEventsPath`), and the messages Consola takes as requests, a mention of the bot or a
// direct message to it.
//
// "Cloud · Design: Slack as a Connection (CON-144)", "Events in",
// https://linear.app/consola/document/cloud-design-slack-as-a-connection-con-144-b235f62bdf94

import type { SlackInstall, StoredSlackApp } from './slack.js';

/** The most of an event's body Consola reads: 1 MB. Slack's events are far smaller. */
export const SLACK_EVENT_MAX_BYTES = 1024 * 1024;

/**
 * How far a request's `X-Slack-Request-Timestamp` may be from now, in seconds, either way:
 * Slack's own five minutes. An older request is refused, so a captured one cannot be replayed later.
 */
export const SLACK_SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

/** A factory's app that was added to a Slack workspace: the only kind that takes events. */
export type InstalledSlackApp = StoredSlackApp & { readonly install: SlackInstall };

export const isInstalled = (app: StoredSlackApp): app is InstalledSlackApp => app.install !== null;

/** A Slack id as Slack writes one: a team (`T…`), an app (`A…`), a user, an event (`Ev…`). */
const SLACK_ID = /^[A-Za-z0-9]{1,64}$/;
/** A `type` as Slack writes one (`event_callback`, `app_mention`). */
const SLACK_TYPE = /^[a-z_.]{1,64}$/;
/** The longest `challenge` Consola echoes. Slack's are a few dozen characters. */
const CHALLENGE_MAX = 512;

/** One event Slack sent a factory's app (`event_callback`), as Consola reads its envelope. */
export type SlackEventCallback = {
  /** The app it was sent to. */
  readonly apiAppId: string;
  /** The Slack workspace it happened in. */
  readonly teamId: string;
  /** Slack's id of the event, which it keeps when it sends the event again. */
  readonly eventId: string;
  /** The inner event's type: `app_mention`, `message`, `reaction_added`… */
  readonly eventType: string;
  /** The inner event as Slack sent it, for `readSlackEvent`. Text from outside the factory. */
  readonly event: Readonly<Record<string, unknown>>;
};

/** What Slack sent, by its outer `type`. */
export type SlackEnvelope =
  /** Slack's check of the request URL: answered with its challenge. */
  | { readonly kind: 'url_verification'; readonly challenge: string }
  | { readonly kind: 'event_callback'; readonly callback: SlackEventCallback }
  /** Anything else Slack sends (`app_rate_limited`, say): acknowledged, and nothing more. */
  | { readonly kind: 'other'; readonly type: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const idOf = (value: unknown): string | null =>
  typeof value === 'string' && SLACK_ID.test(value) ? value : null;

/**
 * What a signed body says, or why it is not something Slack sends: a JSON object with a `type`; a
 * `url_verification` with its challenge; an `event_callback` naming its app, Slack workspace,
 * event id and an inner event with a type. Every id and type has the shape Slack writes, so it
 * can be logged. Never throws.
 */
export function readSlackEnvelope(
  value: unknown,
): { ok: true; envelope: SlackEnvelope } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: 'its body is not a JSON object' };
  const { type } = value;
  if (typeof type !== 'string' || !SLACK_TYPE.test(type)) {
    return { ok: false, reason: 'its body has no type Slack writes' };
  }
  if (type === 'url_verification') {
    const { challenge } = value;
    if (typeof challenge !== 'string' || challenge === '' || challenge.length > CHALLENGE_MAX) {
      return { ok: false, reason: 'its challenge is not text Slack writes' };
    }
    return { ok: true, envelope: { kind: 'url_verification', challenge } };
  }
  if (type !== 'event_callback') return { ok: true, envelope: { kind: 'other', type } };

  const apiAppId = idOf(value.api_app_id);
  const teamId = idOf(value.team_id);
  const eventId = idOf(value.event_id);
  const { event } = value;
  if (apiAppId === null || teamId === null || eventId === null) {
    return { ok: false, reason: 'its event does not name an app, a Slack workspace and an id' };
  }
  if (!isRecord(event) || typeof event.type !== 'string' || !SLACK_TYPE.test(event.type)) {
    return { ok: false, reason: 'its event has no type Slack writes' };
  }
  return {
    ok: true,
    envelope: {
      kind: 'event_callback',
      callback: { apiAppId, teamId, eventId, eventType: event.type, event },
    },
  };
}
