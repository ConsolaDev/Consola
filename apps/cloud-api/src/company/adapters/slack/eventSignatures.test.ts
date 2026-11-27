import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { slackSignatures } from './eventSignatures.js';

const SECRET = 'sprocketsigningsecret0123456789ab';
const NOW = 1_795_000_000;
const encoder = new TextEncoder();
const body = encoder.encode('{"type":"event_callback","event_id":"Ev0SPROCKET"}');

/** Slack's signature of `bytes` at `timestamp` under `secret`, as Slack writes it. */
const signed = (bytes: Uint8Array, timestamp: string, secret = SECRET) =>
  `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(bytes).digest('hex')}`;

const verify = (request: { timestamp?: string; signature?: string; body?: Uint8Array }) =>
  slackSignatures.verify(
    SECRET,
    { body: request.body ?? body, timestamp: request.timestamp, signature: request.signature },
    NOW,
  );

describe('slackSignatures', () => {
  it("takes Slack's own example from its docs", () => {
    const example = encoder.encode(
      'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c',
    );
    expect(
      slackSignatures.verify(
        '8f742231b10e8888abcd99yyyzzz85a5',
        {
          body: example,
          timestamp: '1531420618',
          signature: 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
        },
        1_531_420_618,
      ),
    ).toBe('valid');
  });

  it('takes a signature over the body at a timestamp within five minutes, either way', () => {
    for (const at of [NOW, NOW - 300, NOW + 300]) {
      expect(verify({ timestamp: String(at), signature: signed(body, String(at)) })).toBe('valid');
    }
  });

  it('refuses a timestamp missing, unreadable or more than five minutes away, before the signature', () => {
    for (const timestamp of [undefined, '', 'soon', '-1', '1795000000.5', String(NOW - 301)]) {
      const signature = signed(body, timestamp ?? '');
      expect([timestamp, verify({ timestamp, signature })]).toEqual([timestamp, 'stale']);
    }
    const later = String(NOW + 301);
    expect(verify({ timestamp: later, signature: signed(body, later) })).toBe('stale');
  });

  it('refuses no signature, one of another shape, another secret, another body or another time', () => {
    const at = String(NOW);
    const good = signed(body, at);
    for (const signature of [
      undefined,
      '',
      good.slice(3),
      `v1=${good.slice(3)}`,
      good.toUpperCase(),
      `${good}0`,
      signed(body, at, 'anothersecret0123456789abcdefgh'),
      signed(encoder.encode('{}'), at),
      signed(body, String(NOW - 1)),
    ]) {
      expect([signature, verify({ timestamp: at, signature })]).toEqual([signature, 'mismatch']);
    }
    // One byte changed after it was signed.
    const changed = encoder.encode('{"type":"event_callback","event_id":"Ev0SPROCKEU"}');
    expect(verify({ timestamp: at, signature: good, body: changed })).toBe('mismatch');
  });
});
