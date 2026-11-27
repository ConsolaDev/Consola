import { describe, expect, it } from 'vitest';
import {
  firstLineOf,
  fromAnotherWorkspace,
  inThread,
  readSlackEnvelope,
  readSlackEvent,
} from './slackEvents.js';

const mention = {
  type: 'app_mention',
  user: 'U0ALICE',
  text: '<@U0BOT> price the catalog in euros',
  ts: '1795000000.000100',
  channel: 'C0CATALOG',
  event_ts: '1795000000.000100',
};

const callback = (over: Record<string, unknown> = {}) => ({
  token: 'deprecated-verification-token',
  team_id: 'T0SPROCKET',
  api_app_id: 'A0SPROCKET',
  type: 'event_callback',
  event_id: 'Ev0MENTION',
  event_time: 1_795_000_000,
  event: mention,
  ...over,
});

describe('readSlackEnvelope', () => {
  it("reads Slack's check of the URL, with its challenge", () => {
    expect(
      readSlackEnvelope({ type: 'url_verification', token: 'x', challenge: 'c0ffee' }),
    ).toEqual({ ok: true, envelope: { kind: 'url_verification', challenge: 'c0ffee' } });
  });

  it('reads an event: its app, Slack workspace, id, type and the event as Slack sent it', () => {
    expect(readSlackEnvelope(callback())).toEqual({
      ok: true,
      envelope: {
        kind: 'event_callback',
        callback: {
          apiAppId: 'A0SPROCKET',
          teamId: 'T0SPROCKET',
          eventId: 'Ev0MENTION',
          eventType: 'app_mention',
          event: mention,
        },
      },
    });
  });

  it('takes any other type Slack sends as one to acknowledge', () => {
    expect(readSlackEnvelope({ type: 'app_rate_limited', minute_rate_limited: 1 })).toEqual({
      ok: true,
      envelope: { kind: 'other', type: 'app_rate_limited' },
    });
  });

  it.each([
    ['no object', ['url_verification']],
    ['no type', { challenge: 'c0ffee' }],
    ['a type Slack does not write', { type: 'Event Callback\n' }],
    ['a challenge that is not text', { type: 'url_verification', challenge: 7 }],
    ['an empty challenge', { type: 'url_verification', challenge: '' }],
    [
      'a challenge too long to be Slack’s',
      { type: 'url_verification', challenge: 'c'.repeat(513) },
    ],
    ['an event with no app', callback({ api_app_id: undefined })],
    ['an event with no Slack workspace', callback({ team_id: '' })],
    ['an event with no id', callback({ event_id: null })],
    ['an id Slack does not write', callback({ event_id: 'Ev0\nforged' })],
    ['an event that is no object', callback({ event: 'app_mention' })],
    ['an inner event with no type', callback({ event: { ...mention, type: undefined } })],
  ])('refuses %s', (_kind, body) => {
    expect(readSlackEnvelope(body)).toMatchObject({ ok: false });
  });
});

describe('readSlackEvent', () => {
  const BOT = 'U0BOT';
  const dm = {
    type: 'message',
    channel_type: 'im',
    user: 'U0ALICE',
    text: 'Is the catalog priced in euros yet?',
    ts: '1795000000.000200',
    channel: 'D0ALICE',
  };

  it("takes a mention of the bot, its text without the bot's mention, starting a thread", () => {
    expect(readSlackEvent(mention, BOT)).toEqual({
      kind: 'message',
      message: {
        via: 'mention',
        userId: 'U0ALICE',
        teams: [],
        channelId: 'C0CATALOG',
        ts: '1795000000.000100',
        threadTs: '1795000000.000100',
        text: 'price the catalog in euros',
      },
    });
  });

  it("removes every mention of the bot, as Slack writes them, and no one else's", () => {
    const read = readSlackEvent(
      { ...mention, text: 'Hey <@U0BOT|code-review>, ask <@U0BOB> and <@U0BOT> again\n<@U0BOT>' },
      BOT,
    );
    expect(read).toMatchObject({ message: { text: 'Hey , ask <@U0BOB> and again' } });
  });

  it('takes a direct message to the bot, and a reply in a thread as in that thread', () => {
    expect(readSlackEvent(dm, BOT)).toMatchObject({
      kind: 'message',
      message: { via: 'dm', channelId: 'D0ALICE', threadTs: '1795000000.000200' },
    });
    const reply = readSlackEvent({ ...mention, thread_ts: '1794999999.000001' }, BOT);
    expect(reply).toMatchObject({
      message: { ts: '1795000000.000100', threadTs: '1794999999.000001' },
    });
    if (reply.kind !== 'message') throw new Error('not read');
    expect(inThread(reply.message)).toBe(true);
    const first = readSlackEvent(mention, BOT);
    if (first.kind !== 'message') throw new Error('not read');
    expect(inThread(first.message)).toBe(false);
  });

  it('takes a message with no text as one with none, and keeps its lines', () => {
    expect(readSlackEvent({ ...mention, text: undefined }, BOT)).toMatchObject({
      message: { text: '' },
    });
    expect(readSlackEvent({ ...dm, text: '  First\n\nsecond  ' }, BOT)).toMatchObject({
      message: { text: 'First\n\nsecond' },
    });
  });

  it.each([
    ['a bot', { ...mention, bot_id: 'B0OTHER' }, 'a bot wrote it'],
    ['the bot itself', { ...dm, user: BOT }, 'the bot wrote it'],
    [
      'an edit',
      { ...dm, subtype: 'message_changed' },
      'an edit, a deletion or another kind of message',
    ],
    [
      'a deletion',
      { ...dm, subtype: 'message_deleted' },
      'an edit, a deletion or another kind of message',
    ],
    [
      'a join',
      { ...dm, subtype: 'channel_join' },
      'an edit, a deletion or another kind of message',
    ],
    ['an edited mention', { ...mention, edited: { user: 'U0ALICE', ts: '1' } }, 'an edit'],
    [
      'a channel message',
      { ...dm, channel_type: 'channel' },
      'a message in a channel, with no mention of the bot',
    ],
    [
      'a private channel message',
      { ...dm, channel_type: 'group' },
      'a message in a channel, with no mention of the bot',
    ],
    [
      'a group DM',
      { ...dm, channel_type: 'mpim' },
      'a message in a channel, with no mention of the bot',
    ],
    ['a reaction', { type: 'reaction_added', user: 'U0ALICE', reaction: 'eyes' }, 'a reaction'],
    [
      'a join to a channel',
      { type: 'member_joined_channel', user: 'U0ALICE' },
      'someone joined a channel',
    ],
    ['any other event', { type: 'team_join' }, 'an event Consola does not take'],
    [
      'no author',
      { ...mention, user: undefined },
      'it names no author, channel or timestamp Slack writes',
    ],
    [
      'no channel',
      { ...mention, channel: 7 },
      'it names no author, channel or timestamp Slack writes',
    ],
    [
      'a timestamp of no shape',
      { ...mention, ts: 'now' },
      'it names no author, channel or timestamp Slack writes',
    ],
    ['a thread of no shape', { ...mention, thread_ts: '' }, 'its thread is no timestamp'],
  ])('drops %s', (_kind, event, reason) => {
    expect(readSlackEvent(event, BOT)).toEqual({ kind: 'dropped', reason });
  });

  it('names the Slack workspaces the event says its author and the message belong to', () => {
    const shared = readSlackEvent(
      { ...mention, user_team: 'T0GLOBEX', source_team: 'T0GLOBEX', team: 'T0SPROCKET' },
      BOT,
    );
    if (shared.kind !== 'message') throw new Error('not read');
    expect(shared.message.teams).toEqual(['T0GLOBEX', 'T0GLOBEX', 'T0SPROCKET']);
    expect(fromAnotherWorkspace(shared.message, 'T0SPROCKET')).toBe(true);

    const own = readSlackEvent(
      { ...mention, user_team: 'T0SPROCKET', source_team: 'T0SPROCKET', team: 'T0SPROCKET' },
      BOT,
    );
    if (own.kind !== 'message') throw new Error('not read');
    expect(fromAnotherWorkspace(own.message, 'T0SPROCKET')).toBe(false);

    const unnamed = readSlackEvent(dm, BOT);
    if (unnamed.kind !== 'message') throw new Error('not read');
    expect(fromAnotherWorkspace(unnamed.message, 'T0SPROCKET')).toBe(false);
  });
});

describe('firstLineOf', () => {
  it('is the first line that says something, on one line', () => {
    expect(firstLineOf('\n  \n  Price the\tcatalog  \nin euros', 200)).toBe('Price the catalog');
    expect(firstLineOf('one\u2028two', 200)).toBe('one');
    expect(firstLineOf('   ', 200)).toBe('');
  });

  it('cuts a long line to its length, with an ellipsis, at whole characters', () => {
    expect(firstLineOf('abcdefgh', 5)).toBe('abcd…');
    expect(firstLineOf('🙂🙂🙂🙂🙂🙂', 3)).toBe('🙂🙂…');
    expect(firstLineOf('abcde', 5)).toBe('abcde');
  });
});
