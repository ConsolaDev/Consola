import { inspect } from 'node:util';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlackInstallStateSigner } from './company/adapters/slack/installStateSigner.js';
import { linkTokens } from './company/adapters/slack/linkTokens.js';
import { SLACK_CALLBACK_RESULTS } from './company/adapters/http/slackContract.js';
import { slackApps } from './company/adapters/persistence/slackTables.js';
import { createSlackStores } from './company/adapters/persistence/slackStores.js';
import { LINKED_MESSAGE, requestSlackLink } from './company/application/slackLinks.js';
import type { SlackManifest } from './company/domain/slack.js';
import { ROUTES } from './compose.js';
import { startApi } from './testing/harness.js';
import type { Harness, Member } from './testing/harness.js';

// Slack's routes on the app as `main.ts` composes it (`startApi`, through `composeApi`), with
// Slack itself behind `fetch`: a factory's Slack app (its state, credentials, "Add to Slack",
// Slack's redirect back, Disconnect) and the Slack accounts people link.

/** 32 bytes in base64, for these tests only. */
const SECRETS_KEY = 'c3Byb2NrZXQtY29ubmVjdGlvbi1zZWNyZXRzLWtleSE=';
const TUNNEL = 'https://sprocket-dev.trycloudflare.com';
const WEB = 'http://localhost:5175';
const AUTH_SECRET = 'sprocket-test-secret-that-is-long-enough-to-sign-with';

/** Stand-ins for a Slack app's credentials and its bot token: never real ones. */
const CLIENT_ID = '1111111111.2222222222';
const CLIENT_SECRET = '0123456789abcdef0123456789abcdef';
const SIGNING_SECRET = 'fedcba9876543210fedcba9876543210';
const BOT_TOKEN = 'xoxb-sprocket-0000-test-bot-token';

let harness: Harness;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.close();
});

/** The app on a fresh database: Slack on, unless `on` is false. */
async function start(on = true) {
  harness = await startApi({
    environment: on ? { CONNECTION_SECRETS_KEY: SECRETS_KEY, SLACK_PUBLIC_URL: TUNNEL } : {},
  });
}

type ContractResponse = {
  content: { 'application/json': { schema: { safeParse(value: unknown): { error?: unknown } } } };
};

/** A route's answer, checked against the contract's schema for its status. */
async function answerOf(method: string, path: string, response: Response) {
  const body: unknown = response.status === 204 ? null : await response.json();
  const route = ROUTES.find((r) => r.method === method.toLowerCase() && r.path === path);
  expect(route, `${method} ${path} is in the contract`).toBeDefined();
  const responses = (route?.responses ?? {}) as Record<number, ContractResponse | undefined>;
  const declared = responses[response.status];
  expect(declared, `${method} ${path} declares ${response.status}`).toBeDefined();
  if (body !== null) {
    const parsed = declared?.content['application/json'].schema.safeParse(body);
    expect(
      parsed?.error,
      `${method} ${path} ${response.status} matches the contract`,
    ).toBeUndefined();
  }
  // `any`: the tests read bodies by their fields.
  return { status: response.status, body: body as any };
}

/** A request a page sends, as `who`, to `path`, answered as the contract's `route` declares. */
async function ask(
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  route: string,
  path: string,
  who: Member,
  body?: unknown,
) {
  const response = await harness.app.request(path, {
    method,
    headers: who.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return answerOf(method, route, response);
}

const FACTORY_SLACK = '/api/factories/{factoryId}/slack';
const slackOf = (factoryId: string) => `/api/factories/${factoryId}/slack`;

/** A factory on the owner's first team. */
async function factoryOf(owner: Member, name = 'Code review') {
  const teams = await harness.app.request('/api/teams', { headers: owner.headers });
  const { teams: list } = (await teams.json()) as { teams: Array<{ id: string; first: boolean }> };
  const first = list.find((team) => team.first);
  const made = await harness.app.request('/api/factories', {
    method: 'POST',
    headers: owner.headers,
    body: JSON.stringify({ name, teamId: first?.id }),
  });
  expect(made.status).toBe(201);
  return { ...((await made.json()) as { id: string; name: string }), teamId: first?.id ?? '' };
}

const credentials = {
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  signingSecret: SIGNING_SECRET,
};

/** Every line logged from now on, as one text. */
function logged() {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  return () =>
    spies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((arg) => inspect(arg, { depth: 10 })).join(' '))
      .join('\n');
}

type SlackCall = { method: string; authorization: string | null; body: string };

/** Slack behind `fetch`: each Web API method answers as `answers` says, else `ok: true`. */
function fakeSlack(answers: Record<string, unknown> = {}) {
  const calls: SlackCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://slack.com/api/')) throw new Error(`unexpected fetch of ${url}`);
    const method = url.slice('https://slack.com/api/'.length);
    calls.push({
      method,
      authorization: new Headers(init?.headers).get('authorization'),
      body: String(init?.body ?? ''),
    });
    const answer = answers[method] ?? DEFAULT_ANSWERS[method] ?? { ok: true };
    return new Response(JSON.stringify(answer), { status: 200 });
  });
  return calls;
}

const DEFAULT_ANSWERS: Record<string, unknown> = {
  'oauth.v2.access': {
    ok: true,
    access_token: BOT_TOKEN,
    token_type: 'bot',
    scope: 'app_mentions:read,chat:write',
    bot_user_id: 'U0BOT',
    app_id: 'A0SPROCKET',
    team: { id: 'T0SPROCKET', name: 'Sprocket' },
    is_enterprise_install: false,
  },
  'auth.test': {
    ok: true,
    team: 'Sprocket',
    user: 'code-review',
    team_id: 'T0SPROCKET',
    user_id: 'U0BOT',
    bot_id: 'B0BOT',
  },
  'auth.revoke': { ok: true, revoked: true },
  'chat.postEphemeral': { ok: true, message_ts: '1795000000.000200' },
  'chat.postMessage': { ok: true, channel: 'D0DANA', ts: '1795000000.000200' },
};

/** Where the callback sent the browser, and how it ended. */
function backTo(response: Response) {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location') ?? '');
  return {
    result: location.searchParams.get('slack'),
    hash: location.hash,
    origin: location.origin,
  };
}

/** Saves the credentials, adds the app to Slack, and answers the callback's redirect. */
async function installed(owner: Member, factoryId: string) {
  expect(
    (
      await ask(
        'PUT',
        `${FACTORY_SLACK}/credentials`,
        `${slackOf(factoryId)}/credentials`,
        owner,
        credentials,
      )
    ).status,
  ).toBe(200);
  const started = await ask(
    'POST',
    `${FACTORY_SLACK}/install`,
    `${slackOf(factoryId)}/install`,
    owner,
  );
  const state = new URL(started.body.url).searchParams.get('state') ?? '';
  return harness.app.request(
    `/api/slack/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
  );
}

describe('Slack off', () => {
  it('answers every route that Slack is not configured, and the callback says so', async () => {
    await start(false);
    const owner = await harness.member('owner');
    const factory = await factoryOf(owner);
    const token = linkTokens.newToken();
    for (const [method, route, path, body] of [
      ['GET', FACTORY_SLACK, slackOf(factory.id), undefined],
      ['PUT', `${FACTORY_SLACK}/credentials`, `${slackOf(factory.id)}/credentials`, credentials],
      ['POST', `${FACTORY_SLACK}/install`, `${slackOf(factory.id)}/install`, undefined],
      ['DELETE', FACTORY_SLACK, slackOf(factory.id), undefined],
      ['GET', '/api/slack/link-requests/{token}', `/api/slack/link-requests/${token}`, undefined],
      ['POST', '/api/slack/link-requests/{token}', `/api/slack/link-requests/${token}`, undefined],
      ['GET', '/api/slack/links', '/api/slack/links', undefined],
      ['DELETE', '/api/slack/links/{linkId}', '/api/slack/links/x', undefined],
    ] as const) {
      const answer = await ask(method, route, path, owner, body);
      expect([method, path, answer]).toEqual([
        method,
        path,
        { status: 503, body: { error: 'slack_not_configured' } },
      ]);
    }
    const back = backTo(await harness.app.request('/api/slack/oauth/callback?code=x&state=y'));
    expect(back).toEqual({ result: 'not_configured', hash: '#/settings/connections', origin: WEB });
  });
});

describe("a factory's Slack app", () => {
  it('starts not set up, with the manifest and the addresses to create it from', async () => {
    await start();
    const owner = await harness.member('owner');
    const factory = await factoryOf(owner, 'Code review: the very long factory name, Ünïcode');
    const answer = await ask('GET', FACTORY_SLACK, slackOf(factory.id), owner);
    expect(answer.status).toBe(200);
    const { setup, ...status } = answer.body;
    expect(status).toEqual({
      canManage: true,
      state: 'not_set_up',
      handle: 'code-review-the-very-long-factory-name-unicode',
      clientId: null,
      appId: null,
      appSettingsUrl: null,
      team: null,
      installedAt: null,
    });
    const manifest = setup.manifest as SlackManifest;
    expect(manifest.display_information.name).toBe('Code review: the very long factory');
    expect(manifest.features.bot_user.display_name).toBe(status.handle);
    expect(manifest.features.app_home.messages_tab_enabled).toBe(true);
    expect(manifest.oauth_config.redirect_urls).toEqual([`${TUNNEL}/api/slack/oauth/callback`]);
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      `${TUNNEL}/api/slack/events/${factory.id}`,
    );
    expect(manifest.settings).toMatchObject({
      socket_mode_enabled: false,
      org_deploy_enabled: false,
      token_rotation_enabled: false,
    });
    expect(setup.requestUrl).toBe(`${TUNNEL}/api/slack/events/${factory.id}`);
    expect(setup.redirectUrl).toBe(`${TUNNEL}/api/slack/oauth/callback`);
    const created = new URL(setup.createAppUrl);
    expect(`${created.origin}${created.pathname}`).toBe('https://api.slack.com/apps');
    expect(created.searchParams.get('new_app')).toBe('1');
    expect(JSON.parse(created.searchParams.get('manifest_json') ?? '')).toEqual(manifest);
  });

  it('is seen by a member who sees the factory, who may not change it, and by nobody else', async () => {
    await start();
    const owner = await harness.member('owner');
    const factory = await factoryOf(owner);
    const member = await harness.member('member', { workspace: owner.workspaceId });
    // Not in the factory's team: no such factory.
    expect(await ask('GET', FACTORY_SLACK, slackOf(factory.id), member)).toEqual({
      status: 404,
      body: { error: 'factory_not_found' },
    });
    await harness.app.request(`/api/teams/${factory.teamId}/members/${member.personId}`, {
      method: 'PUT',
      headers: owner.headers,
    });
    const seen = await ask('GET', FACTORY_SLACK, slackOf(factory.id), member);
    expect([seen.status, seen.body.canManage]).toEqual([200, false]);

    for (const [method, route, path, body] of [
      ['PUT', `${FACTORY_SLACK}/credentials`, `${slackOf(factory.id)}/credentials`, credentials],
      ['PUT', `${FACTORY_SLACK}/credentials`, `${slackOf(factory.id)}/credentials`, {}],
      ['POST', `${FACTORY_SLACK}/install`, `${slackOf(factory.id)}/install`, undefined],
      ['DELETE', FACTORY_SLACK, slackOf(factory.id), undefined],
    ] as const) {
      expect(await ask(method, route, path, member, body)).toEqual({
        status: 403,
        body: { error: 'not_allowed' },
      });
    }

    // Another workspace's owner learns nothing of it.
    const stranger = await harness.member('owner');
    expect((await ask('GET', FACTORY_SLACK, slackOf(factory.id), stranger)).status).toBe(404);
    expect(
      (
        await ask(
          'PUT',
          `${FACTORY_SLACK}/credentials`,
          `${slackOf(factory.id)}/credentials`,
          stranger,
          credentials,
        )
      ).status,
    ).toBe(404);
  });

  it('names every problem with the credentials, whatever their shape', async () => {
    await start();
    const owner = await harness.member('owner');
    const factory = await factoryOf(owner);
    const path = `${slackOf(factory.id)}/credentials`;
    expect(await ask('PUT', `${FACTORY_SLACK}/credentials`, path, owner, {})).toEqual({
      status: 400,
      body: {
        error: 'invalid_credentials',
        problems: ['client_id_missing', 'client_secret_missing', 'signing_secret_missing'],
      },
    });
    expect(
      await ask('PUT', `${FACTORY_SLACK}/credentials`, path, owner, {
        clientId: 'A0SPROCKET',
        clientSecret: 42,
        signingSecret: 'not a secret',
      }),
    ).toEqual({
      status: 400,
      body: {
        error: 'invalid_credentials',
        problems: ['client_id_invalid', 'client_secret_missing', 'signing_secret_invalid'],
      },
    });
  });

  it('keeps the credentials sealed, answers no secret, and waits to be added to Slack', async () => {
    await start();
    const owner = await harness.member('owner');
    const factory = await factoryOf(owner);
    const read = logged();
    const saved = await ask(
      'PUT',
      `${FACTORY_SLACK}/credentials`,
      `${slackOf(factory.id)}/credentials`,
      owner,
      {
        ...credentials,
        clientId: ` ${CLIENT_ID} `,
      },
    );
    expect(saved.status).toBe(200);
    expect([saved.body.state, saved.body.clientId]).toEqual(['awaiting_install', CLIENT_ID]);
    expect(JSON.stringify(saved.body)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(saved.body)).not.toContain(SIGNING_SECRET);

    const [row] = await harness.db.company
      .select()
      .from(slackApps)
      .where(eq(slackApps.factoryId, factory.id));
    expect(row?.clientSecret).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(row)).not.toContain(SIGNING_SECRET);
    expect(read()).not.toMatch(new RegExp(`${CLIENT_SECRET}|${SIGNING_SECRET}`));
  });

  it('starts Add to Slack only once it has credentials, at Slack’s authorise page', async () => {
    await start();
    const owner = await harness.member('owner');
    const factory = await factoryOf(owner);
    const install = `${slackOf(factory.id)}/install`;
    expect(await ask('POST', `${FACTORY_SLACK}/install`, install, owner)).toEqual({
      status: 409,
      body: { error: 'credentials_missing' },
    });
    await ask(
      'PUT',
      `${FACTORY_SLACK}/credentials`,
      `${slackOf(factory.id)}/credentials`,
      owner,
      credentials,
    );
    const response = await harness.app.request(install, { method: 'POST', headers: owner.headers });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { body } = await answerOf('POST', `${FACTORY_SLACK}/install`, response);
    const url = new URL(body.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(`${TUNNEL}/api/slack/oauth/callback`);
    expect(url.searchParams.get('scope')?.split(',')).toContain('app_mentions:read');
    expect(
      createSlackInstallStateSigner(AUTH_SECRET).read(url.searchParams.get('state') ?? ''),
    ).toEqual({
      workspaceId: owner.workspaceId,
      factoryId: factory.id,
      personId: owner.personId,
      expiresAt: expect.any(Number),
    });
  });

  it('is added to Slack through the callback, with no session, and keeps the bot token sealed', async () => {
    await start();
    const owner = await harness.member('owner');
    const factory = await factoryOf(owner);
    const calls = fakeSlack();
    const read = logged();
    const back = backTo(await installed(owner, factory.id));
    expect(back).toEqual({
      result: 'installed',
      hash: `#/factories/${factory.id}/settings`,
      origin: WEB,
    });

    const exchanged = calls.find((call) => call.method === 'oauth.v2.access');
    expect(exchanged?.authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(Object.fromEntries(new URLSearchParams(exchanged?.body))).toEqual({
      code: 'code-1',
      redirect_uri: `${TUNNEL}/api/slack/oauth/callback`,
    });

    const status = await ask('GET', FACTORY_SLACK, slackOf(factory.id), owner);
    expect(status.body).toMatchObject({
      state: 'installed',
      handle: 'code-review',
      appId: 'A0SPROCKET',
      appSettingsUrl: 'https://api.slack.com/apps/A0SPROCKET',
      team: { id: 'T0SPROCKET', name: 'Sprocket' },
      installedAt: expect.any(String),
    });
    const [row] = await harness.db.company
      .select()
      .from(slackApps)
      .where(eq(slackApps.factoryId, factory.id));
    expect(row?.botToken).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(BOT_TOKEN);
    expect(read()).not.toContain(BOT_TOKEN);
  });

  it('ends each other way it can, in words the web app reads', async () => {
    await start();
    const owner = await harness.member('owner');
    const factory = await factoryOf(owner);
    await ask(
      'PUT',
      `${FACTORY_SLACK}/credentials`,
      `${slackOf(factory.id)}/credentials`,
      owner,
      credentials,
    );
    const signer = createSlackInstallStateSigner(AUTH_SECRET);
    const now = Math.floor(Date.now() / 1000);
    const state = (overrides: Record<string, unknown> = {}) =>
      encodeURIComponent(
        signer.sign({
          workspaceId: owner.workspaceId,
          factoryId: factory.id,
          personId: owner.personId,
          expiresAt: now + 600,
          ...overrides,
        }),
      );
    const callback = async (query: string) =>
      backTo(await harness.app.request(`/api/slack/oauth/callback?${query}`));
    logged();

    fakeSlack();
    expect(await callback('code=c&state=forged')).toEqual({
      result: 'bad_state',
      hash: '#/settings/connections',
      origin: WEB,
    });
    const atFactory = { hash: `#/factories/${factory.id}/settings`, origin: WEB };
    expect(await callback(`code=c&state=${state({ expiresAt: now - 1 })}`)).toEqual({
      result: 'expired',
      ...atFactory,
    });
    expect(await callback(`error=access_denied&state=${state()}`)).toEqual({
      result: 'cancelled',
      ...atFactory,
    });
    expect(await callback(`state=${state()}`)).toEqual({ result: 'invalid', ...atFactory });
    expect(await callback(`code=c&state=${state({ factoryId: 'gone' })}`)).toEqual({
      result: 'factory_not_found',
      hash: '#/factories/gone/settings',
      origin: WEB,
    });

    vi.restoreAllMocks();
    logged();
    fakeSlack({ 'oauth.v2.access': { ok: false, error: 'invalid_code' } });
    expect(await callback(`code=c&state=${state()}`)).toEqual({
      result: 'code_refused',
      ...atFactory,
    });

    vi.restoreAllMocks();
    logged();
    fakeSlack({
      'oauth.v2.access': {
        ...(DEFAULT_ANSWERS['oauth.v2.access'] as object),
        is_enterprise_install: true,
      },
    });
    expect(await callback(`code=c&state=${state()}`)).toEqual({
      result: 'enterprise_install',
      ...atFactory,
    });

    // The person who started it is no longer an admin.
    const admin = await harness.member('admin', { workspace: owner.workspaceId });
    await harness.setRole(admin.personId, owner.workspaceId, 'member');
    expect(await callback(`code=c&state=${state({ personId: admin.personId })}`)).toEqual({
      result: 'not_allowed',
      ...atFactory,
    });

    expect(SLACK_CALLBACK_RESULTS).toEqual(
      expect.arrayContaining(['installed', 'bad_state', 'not_configured']),
    );
    expect((await ask('GET', FACTORY_SLACK, slackOf(factory.id), owner)).body.state).toBe(
      'awaiting_install',
    );
  });

  it('holds one Slack app for one factory', async () => {
    await start();
    const owner = await harness.member('owner');
    const review = await factoryOf(owner, 'Code review');
    const triage = await factoryOf(owner, 'Triage');
    fakeSlack();
    logged();
    expect(backTo(await installed(owner, review.id)).result).toBe('installed');
    expect(backTo(await installed(owner, triage.id)).result).toBe('app_taken');
    expect((await ask('GET', FACTORY_SLACK, slackOf(triage.id), owner)).body.state).toBe(
      'awaiting_install',
    );
  });

  it('disconnects: revokes the bot token and forgets the app', async () => {
    await start();
    const owner = await harness.member('owner');
    const factory = await factoryOf(owner);
    expect(await ask('DELETE', FACTORY_SLACK, slackOf(factory.id), owner)).toEqual({
      status: 404,
      body: { error: 'slack_not_set_up' },
    });
    const calls = fakeSlack();
    logged();
    await installed(owner, factory.id);
    expect(await ask('DELETE', FACTORY_SLACK, slackOf(factory.id), owner)).toEqual({
      status: 204,
      body: null,
    });
    expect(calls.filter((call) => call.method === 'auth.revoke')).toEqual([
      { method: 'auth.revoke', authorization: `Bearer ${BOT_TOKEN}`, body: '' },
    ]);
    expect((await ask('GET', FACTORY_SLACK, slackOf(factory.id), owner)).body.state).toBe(
      'not_set_up',
    );
  });
});

describe('linking a Slack account', () => {
  /** A one-time link a Slack user got from the factory's bot, as lane C's events make one. */
  async function linkFor(owner: Member, factoryId: string, channelId = 'C0GENERAL') {
    const { url } = await requestSlackLink(
      {
        links: createSlackStores(harness.db.company).links,
        tokens: linkTokens,
        clock: { nowSeconds: () => Math.floor(Date.now() / 1000) },
      },
      {
        workspaceId: owner.workspaceId,
        factoryId,
        slackTeamId: 'T0SPROCKET',
        slackUserId: 'U0DANA',
        channelId,
      },
      WEB,
    );
    expect(url.startsWith(`${WEB}/#/slack/link/`)).toBe(true);
    return url.slice(`${WEB}/#/slack/link/`.length);
  }

  const REQUEST = '/api/slack/link-requests/{token}';
  const requestOf = (token: string) => `/api/slack/link-requests/${token}`;

  it('shows the link, links the person once, and the bot says so where they wrote', async () => {
    await start();
    const owner = await harness.member('owner');
    const factory = await factoryOf(owner);
    const calls = fakeSlack();
    logged();
    await installed(owner, factory.id);
    const token = await linkFor(owner, factory.id);

    const shown = await ask('GET', REQUEST, requestOf(token), owner);
    expect(shown).toEqual({
      status: 200,
      body: {
        state: 'open',
        workspaceId: owner.workspaceId,
        inActiveWorkspace: true,
        slackTeamId: 'T0SPROCKET',
        slackUserId: 'U0DANA',
        slackTeamName: 'Sprocket',
        factory: { id: factory.id, name: 'Code review' },
        expiresAt: expect.any(String),
      },
    });

    const linked = await ask('POST', REQUEST, requestOf(token), owner);
    expect(linked).toEqual({
      status: 200,
      body: {
        id: expect.any(String),
        slackTeamId: 'T0SPROCKET',
        slackTeamName: 'Sprocket',
        slackUserId: 'U0DANA',
        linkedAt: expect.any(String),
      },
    });
    const said = calls.filter((call) => call.method === 'chat.postEphemeral');
    expect(said.map((call) => [call.authorization, JSON.parse(call.body)])).toEqual([
      [`Bearer ${BOT_TOKEN}`, { channel: 'C0GENERAL', user: 'U0DANA', text: LINKED_MESSAGE }],
    ]);

    expect(await ask('POST', REQUEST, requestOf(token), owner)).toEqual({
      status: 409,
      body: { error: 'link_used' },
    });
    expect((await ask('GET', REQUEST, requestOf(token), owner)).body.state).toBe('used');

    const mine = await ask('GET', '/api/slack/links', '/api/slack/links', owner);
    expect(mine).toEqual({ status: 200, body: { links: [linked.body] } });
  });

  it('says it in a DM as a message', async () => {
    await start();
    const owner = await harness.member('owner');
    const factory = await factoryOf(owner);
    const calls = fakeSlack();
    logged();
    await installed(owner, factory.id);
    const token = await linkFor(owner, factory.id, 'D0DANA');
    expect((await ask('POST', REQUEST, requestOf(token), owner)).status).toBe(200);
    const said = calls.filter((call) => call.method.startsWith('chat.'));
    expect(said.map((call) => [call.method, JSON.parse(call.body)])).toEqual([
      ['chat.postMessage', { channel: 'D0DANA', text: LINKED_MESSAGE }],
    ]);
  });

  it('refuses a link of another workspace, one it does not have, and one that expired', async () => {
    await start();
    const owner = await harness.member('owner');
    const factory = await factoryOf(owner);
    const token = await linkFor(owner, factory.id);

    const stranger = await harness.member('owner');
    expect(await ask('GET', REQUEST, requestOf(token), stranger)).toEqual({
      status: 200,
      body: {
        state: 'open',
        workspaceId: owner.workspaceId,
        inActiveWorkspace: false,
        slackTeamId: 'T0SPROCKET',
        slackUserId: 'U0DANA',
        slackTeamName: null,
        factory: null,
        expiresAt: expect.any(String),
      },
    });
    expect(await ask('POST', REQUEST, requestOf(token), stranger)).toEqual({
      status: 409,
      body: { error: 'other_workspace' },
    });

    for (const unknown of [linkTokens.newToken(), 'short']) {
      expect(await ask('GET', REQUEST, requestOf(unknown), owner)).toEqual({
        status: 404,
        body: { error: 'link_not_found' },
      });
      expect(await ask('POST', REQUEST, requestOf(unknown), owner)).toEqual({
        status: 404,
        body: { error: 'link_not_found' },
      });
    }

    const { links } = createSlackStores(harness.db.company);
    const expired = linkTokens.newToken();
    await links.createRequest({
      tokenHash: linkTokens.hashOf(expired),
      workspaceId: owner.workspaceId,
      factoryId: factory.id,
      slackTeamId: 'T0SPROCKET',
      slackUserId: 'U0ELI',
      channelId: 'C0GENERAL',
      createdAt: new Date(Date.now() - 20 * 60_000),
      expiresAt: new Date(Date.now() - 5 * 60_000),
      usedAt: null,
    });
    expect(await ask('POST', REQUEST, requestOf(expired), owner)).toEqual({
      status: 409,
      body: { error: 'link_expired' },
    });
  });

  it('never links one Slack account to two people, and unlinks only one’s own', async () => {
    await start();
    const owner = await harness.member('owner');
    const factory = await factoryOf(owner);
    const admin = await harness.member('admin', { workspace: owner.workspaceId });
    const linked = await ask('POST', REQUEST, requestOf(await linkFor(owner, factory.id)), owner);
    expect(linked.status).toBe(200);
    expect(await ask('POST', REQUEST, requestOf(await linkFor(owner, factory.id)), admin)).toEqual({
      status: 409,
      body: { error: 'linked_to_someone_else' },
    });

    const route = '/api/slack/links/{linkId}';
    expect(await ask('DELETE', route, `/api/slack/links/${linked.body.id}`, admin)).toEqual({
      status: 404,
      body: { error: 'link_not_found' },
    });
    expect(await ask('DELETE', route, `/api/slack/links/${linked.body.id}`, owner)).toEqual({
      status: 204,
      body: null,
    });
    expect((await ask('GET', '/api/slack/links', '/api/slack/links', owner)).body).toEqual({
      links: [],
    });
  });
});
