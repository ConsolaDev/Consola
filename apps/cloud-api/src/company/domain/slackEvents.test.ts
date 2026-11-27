import { describe, expect, it } from 'vitest';
import { readSlackEnvelope } from './slackEvents.js';

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
