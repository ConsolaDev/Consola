import { describe, expect, it } from 'vitest';
import { createSlackApi } from './slackApi.js';

/** A stand-in bot token: never a real one. */
const TOKEN = 'xoxb-sprocket-0000-test-token';

type Sent = { url: string; init: RequestInit };

/** A fetch that answers each call with `answer`, and keeps what was sent. */
function fakeSlack(answer: () => Response | Promise<Response>): {
  sent: Sent[];
  fetch: (url: string, init: RequestInit) => Promise<Response>;
} {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return answer();
    },
  };
}

const slack =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const headerOf = (sent: Sent | undefined, name: string) =>
  new Headers(sent?.init.headers).get(name);

describe("Slack's Web API", () => {
  it('exchanges an Add to Slack code with the app’s credentials, as Basic auth', async () => {
    const { sent, fetch } = fakeSlack(
      slack({
        ok: true,
        access_token: TOKEN,
        token_type: 'bot',
        scope: 'app_mentions:read,chat:write',
        bot_user_id: 'U0BOT',
        app_id: 'A0SPROCKET',
        team: { id: 'T0SPROCKET', name: 'Sprocket' },
        enterprise: null,
        is_enterprise_install: false,
        authed_user: { id: 'U0DANA' },
      }),
    );
    const answer = await createSlackApi({ fetch }).oauthAccess({
      clientId: '1111.2222',
      clientSecret: 'client-secret',
      code: 'code-1',
      redirectUri: 'https://api.sprocket.test/api/slack/oauth/callback',
    });
    expect(answer).toEqual({
      ok: true,
      value: {
        botToken: TOKEN,
        tokenType: 'bot',
        scopes: ['app_mentions:read', 'chat:write'],
        appId: 'A0SPROCKET',
        botUserId: 'U0BOT',
        team: { id: 'T0SPROCKET', name: 'Sprocket' },
        enterpriseInstall: false,
      },
    });
    const [call] = sent;
    expect(call?.url).toBe('https://slack.com/api/oauth.v2.access');
    expect(call?.init.method).toBe('POST');
    expect(headerOf(call, 'authorization')).toBe(
      `Basic ${Buffer.from('1111.2222:client-secret').toString('base64')}`,
    );
    expect(headerOf(call, 'content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(String(call?.init.body)))).toEqual({
      code: 'code-1',
      redirect_uri: 'https://api.sprocket.test/api/slack/oauth/callback',
    });
  });

  it('sends the token as a bearer, never in the address or the body', async () => {
    const { sent, fetch } = fakeSlack(slack({ ok: true, channel: 'C0GENERAL', ts: '1795.0002' }));
    const api = createSlackApi({ fetch });
    const answer = await api.postMessage(TOKEN, {
      channel: 'C0GENERAL',
      text: 'On it.',
      blocks: [{ type: 'markdown', text: '**On it.**' }],
      threadTs: '1795.0001',
    });
    expect(answer).toEqual({ ok: true, value: { channel: 'C0GENERAL', ts: '1795.0002' } });
    const [call] = sent;
    expect(call?.url).toBe('https://slack.com/api/chat.postMessage');
    expect(headerOf(call, 'authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headerOf(call, 'content-type')).toBe('application/json; charset=utf-8');
    expect(JSON.parse(String(call?.init.body))).toEqual({
      channel: 'C0GENERAL',
      text: 'On it.',
      blocks: [{ type: 'markdown', text: '**On it.**' }],
      thread_ts: '1795.0001',
    });
    expect(call?.url).not.toContain(TOKEN);
    expect(String(call?.init.body)).not.toContain(TOKEN);
  });

  it('calls each method release 1 needs, and reads its answer', async () => {
    const answers: Record<string, unknown> = {
      'auth.revoke': { ok: true, revoked: true },
      'auth.test': {
        ok: true,
        url: 'https://sprocket.slack.com/',
        team: 'Sprocket',
        user: 'code-review',
        team_id: 'T0SPROCKET',
        user_id: 'U0BOT',
        bot_id: 'B0BOT',
      },
      'chat.postEphemeral': { ok: true, message_ts: '1795.0003' },
      'reactions.add': { ok: true },
      'chat.getPermalink': {
        ok: true,
        channel: 'C0GENERAL',
        permalink: 'https://sprocket.slack.com/archives/C0GENERAL/p17950001',
      },
    };
    const sent: Sent[] = [];
    const api = createSlackApi({
      fetch: async (url, init) => {
        sent.push({ url, init });
        const method = url.split('/').pop() ?? '';
        return new Response(JSON.stringify(answers[method]), { status: 200 });
      },
    });

    expect(await api.authRevoke(TOKEN)).toEqual({ ok: true, value: { revoked: true } });
    expect(await api.authTest(TOKEN)).toEqual({
      ok: true,
      value: {
        teamId: 'T0SPROCKET',
        team: 'Sprocket',
        userId: 'U0BOT',
        user: 'code-review',
        botId: 'B0BOT',
      },
    });
    expect(
      await api.postEphemeral(TOKEN, { channel: 'C0GENERAL', user: 'U0DANA', text: 'Link first.' }),
    ).toEqual({ ok: true, value: { messageTs: '1795.0003' } });
    expect(
      await api.addReaction(TOKEN, { channel: 'C0GENERAL', timestamp: '1795.0001', name: 'eyes' }),
    ).toEqual({ ok: true, value: null });
    expect(await api.getPermalink(TOKEN, { channel: 'C0GENERAL', messageTs: '1795.0001' })).toEqual(
      {
        ok: true,
        value: { permalink: 'https://sprocket.slack.com/archives/C0GENERAL/p17950001' },
      },
    );

    expect(sent.map((call) => call.url.replace('https://slack.com/api/', ''))).toEqual([
      'auth.revoke',
      'auth.test',
      'chat.postEphemeral',
      'reactions.add',
      'chat.getPermalink',
    ]);
    expect(JSON.parse(String(sent[2]?.init.body))).toEqual({
      channel: 'C0GENERAL',
      user: 'U0DANA',
      text: 'Link first.',
    });
    expect(JSON.parse(String(sent[3]?.init.body))).toEqual({
      channel: 'C0GENERAL',
      timestamp: '1795.0001',
      name: 'eyes',
    });
    expect(Object.fromEntries(new URLSearchParams(String(sent[4]?.init.body)))).toEqual({
      channel: 'C0GENERAL',
      message_ts: '1795.0001',
    });
    for (const call of sent) {
      expect(headerOf(call, 'authorization')).toBe(`Bearer ${TOKEN}`);
      expect(call.init.redirect).toBe('error');
    }
  });

  it("answers Slack's error code when it refuses", async () => {
    const { fetch } = fakeSlack(slack({ ok: false, error: 'token_revoked' }));
    expect(await createSlackApi({ fetch }).authTest(TOKEN)).toEqual({
      ok: false,
      error: { kind: 'refused', code: 'token_revoked' },
    });
  });

  it('reads an error code of no shape Slack writes as unknown', async () => {
    const { fetch } = fakeSlack(slack({ ok: false, error: `<${TOKEN}> nope` }));
    expect(await createSlackApi({ fetch }).authTest(TOKEN)).toEqual({
      ok: false,
      error: { kind: 'refused', code: 'unknown' },
    });
  });

  it('answers a rate limit as ratelimited', async () => {
    const { fetch } = fakeSlack(
      () => new Response('', { status: 429, headers: { 'retry-after': '3' } }),
    );
    expect(
      await createSlackApi({ fetch }).addReaction(TOKEN, {
        channel: 'C',
        timestamp: '1',
        name: 'eyes',
      }),
    ).toEqual({
      ok: false,
      error: { kind: 'refused', code: 'ratelimited' },
    });
  });

  it.each([
    [
      'a server error',
      slack({ ok: false, error: 'fatal_error' }, 500),
      'chat.postMessage: HTTP 500',
    ],
    [
      'an answer that is not JSON',
      () => new Response('<html>', { status: 200 }),
      'chat.postMessage: the answer is not JSON',
    ],
    [
      'an answer of another shape',
      slack({ ok: true }),
      'chat.postMessage: an answer of a shape Slack does not give',
    ],
    [
      'a network failure',
      () => Promise.reject(new TypeError(`fetch failed for ${TOKEN}`)),
      'chat.postMessage: could not reach Slack',
    ],
    [
      'no answer in time',
      () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
      'chat.postMessage: no answer in time',
    ],
  ])('answers %s as unavailable, naming no token', async (_what, answer, reason) => {
    const { fetch } = fakeSlack(answer);
    const result = await createSlackApi({ fetch }).postMessage(TOKEN, { channel: 'C', text: 'x' });
    expect(result).toEqual({ ok: false, error: { kind: 'unavailable', reason } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
