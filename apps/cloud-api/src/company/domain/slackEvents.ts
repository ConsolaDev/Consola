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
  /**
   * Whether it happened in a channel shared with another organisation (Slack Connect): the
   * envelope's `is_ext_shared_channel`, which Slack has been seen to write as `true` or `"true"`.
   */
  readonly sharedChannel: boolean;
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
      callback: {
        apiAppId,
        teamId,
        eventId,
        eventType: event.type,
        event,
        sharedChannel:
          value.is_ext_shared_channel === true || value.is_ext_shared_channel === 'true',
      },
    },
  };
}

// The messages Consola takes as requests: a mention of the factory's bot, and a direct message to
// it. Release 1 takes no other event, though the app is subscribed to more, so that release 2 needs
// no reinstall.

/** A message's timestamp as Slack writes one: its id in the channel (`1795000000.000100`). */
const SLACK_TS = /^[0-9]{1,12}\.[0-9]{1,12}$/;

/** A message someone wrote to a factory's bot, as Consola takes it. Text from outside the factory. */
export type SlackMessage = {
  /** `mention`: the bot was mentioned in a channel (`app_mention`); `dm`: sent to it directly. */
  readonly via: 'mention' | 'dm';
  /** Who wrote it: their Slack user id. */
  readonly userId: string;
  /**
   * The Slack workspaces the event says its author and the message belong to (`user_team`,
   * `source_team`, `team`), each one it names. In a channel shared through Slack Connect, an
   * author from another organisation shows there.
   */
  readonly teams: readonly string[];
  readonly channelId: string;
  /** The message's own timestamp. */
  readonly ts: string;
  /** The thread it is in: `thread_ts`, or its own timestamp when it starts one. */
  readonly threadTs: string;
  /** What they wrote, without the bot's mention, trimmed. May be empty. */
  readonly text: string;
};

/** What reading one event found: a message to take, or why it is dropped. */
export type ReadSlackEvent =
  | { readonly kind: 'message'; readonly message: SlackMessage }
  | { readonly kind: 'dropped'; readonly reason: string };

const tsOf = (value: unknown): string | null =>
  typeof value === 'string' && SLACK_TS.test(value) ? value : null;

/** `<@U0BOT>` and `<@U0BOT|name>`, how Slack writes a mention of the bot, with a space after it. */
function mentionOf(botUserId: string): RegExp {
  return new RegExp(`<@${botUserId.replaceAll(/[^A-Za-z0-9]/g, '')}(?:\\|[^>]*)?>[ \\t]?`, 'g');
}

/**
 * The message an event of a factory's app holds, as Consola takes it, or why it is dropped:
 *
 * - an `app_mention` (a mention of the bot in a channel), its text without the bot's mention;
 * - a `message` in a direct message to the bot (`channel_type: im`);
 * - nothing a bot wrote (`bot_id`), the factory's own bot included, nothing with a `subtype`
 *   (edits, deletions, joins and the like), and no edit (`edited`);
 * - in release 1, no message posted in a channel without a mention, and no reaction.
 *
 * The thread is `thread_ts ?? ts`. Never throws.
 */
export function readSlackEvent(
  event: Readonly<Record<string, unknown>>,
  botUserId: string,
): ReadSlackEvent {
  const { type } = event;
  if (type === 'reaction_added') return { kind: 'dropped', reason: 'a reaction' };
  if (type === 'member_joined_channel') {
    return { kind: 'dropped', reason: 'someone joined a channel' };
  }
  if (type !== 'app_mention' && type !== 'message') {
    return { kind: 'dropped', reason: 'an event Consola does not take' };
  }
  if (event.bot_id !== undefined) return { kind: 'dropped', reason: 'a bot wrote it' };
  if (event.subtype !== undefined) {
    return { kind: 'dropped', reason: 'an edit, a deletion or another kind of message' };
  }
  if (event.edited !== undefined) return { kind: 'dropped', reason: 'an edit' };
  if (event.user === botUserId) return { kind: 'dropped', reason: 'the bot wrote it' };

  const via = type === 'app_mention' ? 'mention' : event.channel_type === 'im' ? 'dm' : null;
  if (via === null) {
    return { kind: 'dropped', reason: 'a message in a channel, with no mention of the bot' };
  }
  const userId = idOf(event.user);
  const channelId = idOf(event.channel);
  const ts = tsOf(event.ts);
  if (userId === null || channelId === null || ts === null) {
    return { kind: 'dropped', reason: 'it names no author, channel or timestamp Slack writes' };
  }
  const threadTs = event.thread_ts === undefined ? ts : tsOf(event.thread_ts);
  if (threadTs === null) return { kind: 'dropped', reason: 'its thread is no timestamp' };

  const teams = [event.user_team, event.source_team, event.team].filter(
    (team): team is string => typeof team === 'string' && team !== '',
  );
  const text = typeof event.text === 'string' ? event.text : '';
  return {
    kind: 'message',
    message: {
      via,
      userId,
      teams,
      channelId,
      ts,
      threadTs,
      text: text.replace(mentionOf(botUserId), '').trim(),
    },
  };
}

/**
 * Whether the message's author may belong to another Slack workspace than the app's, Slack
 * Connect, whose people Consola does not take requests from: a workspace the event names for its
 * author or itself (`user_team`, `source_team`, `team`) is not the app's; or the channel is shared
 * with another organisation (`sharedChannel`) and the event names none, so nothing says the author
 * is the app's own.
 *
 * Being in a shared channel alone refuses nobody: the app's own people talk there too, and only
 * where the author belongs counts. `is_ext_shared_channel` says the channel is shared, not where
 * its author belongs, so it is no flag to refuse every message on.
 */
export function fromAnotherWorkspace(
  message: SlackMessage,
  appTeamId: string,
  sharedChannel = false,
): boolean {
  if (message.teams.some((team) => team !== appTeamId)) return true;
  return sharedChannel && message.teams.length === 0;
}

/** Whether the message was written in a thread, rather than starting one. */
export const inThread = (message: SlackMessage): boolean => message.threadTs !== message.ts;

/** A control character: a line break, a tab, an escape. */
const CONTROL = /\p{Cc}+/gu;

/**
 * The first line of `text` that says something, on one line, cut to `max` characters with an
 * ellipsis; empty when it says nothing.
 */
export function firstLineOf(text: string, max: number): string {
  const line =
    text
      .split(/\r\n|\r|\n|\u2028|\u2029/)
      .map((each) => each.replaceAll(CONTROL, ' ').trim())
      .find((each) => each !== '') ?? '';
  const characters = [...line];
  if (characters.length <= max) return line;
  return `${characters
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}
