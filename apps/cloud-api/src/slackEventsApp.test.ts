import { createHmac, randomBytes } from 'node:crypto';
import { CODE_REVIEW_TEAM_FILES } from '@consola/factory-spec';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';
import { getCloudSession, getRun } from './company/adapters/http/contract.js';
import { postSlackEvent } from './company/adapters/http/slackEventsContract.js';
import { createSlackStores } from './company/adapters/persistence/slackStores.js';
import { createDrizzleStores } from './company/adapters/persistence/stores.js';
import { recordRun } from './company/application/runs.js';
import { agentRunRecord } from './company/domain/agentRun.js';
import type { CloudSession } from './company/domain/cloudSession.js';
import { createSecretSealer } from './company/adapters/sealing/secretSealer.js';
import { startApi } from './testing/harness.js';
import type { Harness, Member } from './testing/harness.js';

// Slack's events through the whole API, as `main.ts` composes it, with Slack on: the front door
// (which leaves the route outside the origin check), the real stores, the sealer, the signature
// check and Slack's Web API adapter, whose calls a stand-in `fetch` answers for Slack. Every answer
// is read with the schema the contract declares for its status.

const SECRETS_KEY = randomBytes(32).toString('base64');
const SIGNING_SECRET = 'sprocketsigningsecret0123456789ab';

let harness: Harness;
let owner: Member;
let factoryId: string;

beforeEach(async () => {
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
  harness = await startApi({ environment: { CONNECTION_SECRETS_KEY: SECRETS_KEY } });
  owner = await harness.member('owner');
  const { teams, factories } = createDrizzleStores(harness.db.company);
  const [first] = await teams.list(owner.workspaceId);
  if (!first) throw new Error('The workspace has no first team');
  const made = await factories.create(owner.workspaceId, {
    name: 'Code review',
    teamId: first.id,
    personId: owner.personId,
  });
  if (typeof made === 'string') throw new Error(made);
  factoryId = made.id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await harness.close();
});

/** The factory's app, its credentials sealed with the server's own key, added to Sprocket's Slack. */
async function installSlackApp() {
  const sealer = createSecretSealer(SECRETS_KEY);
  const { apps } = createSlackStores(harness.db.company);
  await apps.saveCredentials({
    workspaceId: owner.workspaceId,
    factoryId,
    clientId: '1111.2222',
    clientSecret: sealer.seal('client-secret'),
    signingSecret: sealer.seal(SIGNING_SECRET),
    handle: 'code-review',
    configuredBy: owner.personId,
    at: new Date(),
  });
  await apps.install({
    workspaceId: owner.workspaceId,
    factoryId,
    clientId: '1111.2222',
    install: {
      appId: 'A0SPROCKET',
      teamId: 'T0SPROCKET',
      teamName: 'Sprocket',
      botUserId: 'U0BOT',
      installedBy: owner.personId,
      installedAt: new Date(),
    },
    botToken: sealer.seal('xoxb-sprocket'),
    handle: 'code-review',
  });
}

type DeclaredAnswer = { content?: Record<string, { schema: ZodType }> };
type Declaring = { responses: unknown };

/** Status and body, the body read with the schema `route` declares for the status. */
async function answered(
  response: Response,
  route: Declaring = postSlackEvent,
): Promise<[number, unknown]> {
  const declared = (route.responses as Record<number, DeclaredAnswer>)[response.status];
  expect(declared, `the contract declares ${response.status}`).toBeDefined();
  const schema = declared?.content?.['application/json']?.schema;
  if (!schema) throw new Error(`${response.status} declares no body`);
  return [response.status, schema.parse(await response.json())];
}

/** POSTs `body` as Slack would, signed unless `secret` is null, from wherever `origin` says. */
function send(body: unknown, options: { secret?: string | null; origin?: string } = {}) {
  const text = JSON.stringify(body);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.origin !== undefined) headers.set('origin', options.origin);
  const secret = options.secret === undefined ? SIGNING_SECRET : options.secret;
  if (secret !== null) {
    const now = String(Math.floor(Date.now() / 1000));
    headers.set('x-slack-request-timestamp', now);
    const hmac = createHmac('sha256', secret).update(`v0:${now}:${text}`).digest('hex');
    headers.set('x-slack-signature', `v0=${hmac}`);
  }
  return harness.app.request(`/api/slack/events/${factoryId}`, {
    method: 'POST',
    headers,
    body: text,
  });
}

const challenge = { type: 'url_verification', token: 'x', challenge: 'c0ffee' };
const callback = {
  type: 'event_callback',
  team_id: 'T0SPROCKET',
  api_app_id: 'A0SPROCKET',
  event_id: 'Ev0MENTION',
  event: {
    type: 'reaction_added',
    user: 'U0ALICE',
    reaction: 'eyes',
    item: { type: 'message', channel: 'C0CATALOG', ts: '1795000000.000100' },
  },
};

describe("Slack's events, through the whole API", () => {
  it("answers Slack's check of the URL before the factory has a signing secret, and nothing else", async () => {
    expect(await answered(await send(challenge, { secret: null }))).toEqual([
      200,
      { challenge: 'c0ffee' },
    ]);
    expect(await answered(await send(callback))).toEqual([409, { error: 'slack_not_set_up' }]);
  });

  it('checks, records and accepts an event, outside the origin check', async () => {
    await installSlackApp();
    expect(await answered(await send(callback, { secret: 'another' }))).toEqual([
      401,
      { error: 'bad_signature' },
    ]);
    expect(await answered(await send(challenge))).toEqual([200, { challenge: 'c0ffee' }]);
    expect(await answered(await send(callback, { origin: 'https://sprocket.example' }))).toEqual([
      200,
      { result: 'accepted' },
    ]);
    expect(await answered(await send(callback))).toEqual([200, { result: 'duplicate' }]);
  });

  it('names no factory it does not have', async () => {
    const response = await harness.app.request('/api/slack/events/no-such-factory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(challenge),
    });
    expect(await answered(response)).toEqual([404, { error: 'factory_not_found' }]);
  });
});

/** Each call the app made to Slack's Web API: its method and the JSON it sent. */
type SlackCall = { method: string; body: Record<string, unknown> };

/** Answers Slack's Web API as Slack would, and lets every other address through. */
function standInForSlack(): SlackCall[] {
  const calls: SlackCall[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://slack.com/api/')) return real(input, init);
    const method = url.slice('https://slack.com/api/'.length);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    const answers: Record<string, unknown> = {
      'chat.postEphemeral': { ok: true, message_ts: '1795000100.000001' },
      'chat.postMessage': { ok: true, channel: body.channel, ts: '1795000100.000002' },
      'chat.getPermalink': {
        ok: true,
        permalink: 'https://sprocket.slack.com/archives/C0CATALOG/p1795000000000100',
      },
      'reactions.add': { ok: true },
    };
    return Response.json(answers[method] ?? { ok: false, error: 'unknown_method' });
  });
  return calls;
}

let mentions = 0;
/** An event of the factory's app: Alice, or whoever `user` names, mentions its bot. */
const mentionBy = (user: string) => ({
  type: 'event_callback',
  team_id: 'T0SPROCKET',
  api_app_id: 'A0SPROCKET',
  event_id: `Ev0MENTION${++mentions}`,
  event: {
    type: 'app_mention',
    user,
    text: '<@U0BOT> price the catalog in euros',
    ts: '1795000000.000100',
    channel: 'C0CATALOG',
  },
});

describe('a mention of the bot, through the whole API', () => {
  it('sends an unlinked author a one-time link to the web app, for them alone', async () => {
    const calls = standInForSlack();
    await installSlackApp();
    expect(await answered(await send(mentionBy('U0ALICE')))).toEqual([200, { result: 'accepted' }]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const [whisper] = calls;
    expect(whisper?.method).toBe('chat.postEphemeral');
    expect(whisper?.body).toMatchObject({ channel: 'C0CATALOG', user: 'U0ALICE' });
    expect(String(whisper?.body.text)).toMatch(
      new RegExp(
        `^Link your Slack account to Consola before I take your request: ${harness.config.publicUrl}/#/slack/link/[A-Za-z0-9_-]{43}\n`,
      ),
    );
  });

  it("starts a linked member's request, and says in the thread when no runner takes it", async () => {
    const calls = standInForSlack();
    await installSlackApp();
    const { factories } = createDrizzleStores(harness.db.company);
    const saved = await factories.save(owner.workspaceId, factoryId, {
      baseVersion: 1,
      files: [
        ...CODE_REVIEW_TEAM_FILES,
        { path: 'factory.yml', content: 'version: 1\nrepos: [sprocket/catalog-portal]\n' },
      ],
      personId: owner.personId,
    });
    expect(saved.kind).toBe('saved');
    const { links } = createSlackStores(harness.db.company);
    await links.createRequest({
      tokenHash: 'hash-of-alice',
      workspaceId: owner.workspaceId,
      factoryId,
      slackTeamId: 'T0SPROCKET',
      slackUserId: 'U0ALICE',
      channelId: 'C0CATALOG',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
    await links.confirm({ tokenHash: 'hash-of-alice', personId: owner.personId, at: new Date() });

    expect(await answered(await send(mentionBy('U0ALICE')))).toEqual([200, { result: 'accepted' }]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls).toEqual([
      {
        method: 'chat.postMessage',
        body: {
          channel: 'C0CATALOG',
          thread_ts: '1795000000.000100',
          text: 'No runner was connected for this workspace, so nothing ran.',
        },
      },
    ]);
  });
});

describe('a request from Slack, as the web app reads it', () => {
  it('reads its session and its run through the contract, with their Slack kinds', async () => {
    const permalink = 'https://sprocket.slack.com/archives/C0CATALOG/p1795000000000100';
    const session: CloudSession = {
      id: 'slack-request-1',
      workspaceId: owner.workspaceId,
      personId: null,
      repository: 'sprocket/catalog-portal',
      harness: 'claude',
      status: 'running',
      title: 'Code review · Slack: price the catalog in euros',
      hostUrl: null,
      error: null,
      errorCode: null,
      runnerId: 'runner-1',
      createdAt: Math.floor(Date.now() / 1000),
      endedAt: null,
      origin: {
        kind: 'slack',
        factoryId,
        factoryName: 'Code review',
        agent: 'orchestrator',
        via: 'dm',
        message: {
          teamId: 'T0SPROCKET',
          channelId: 'D0ALICE',
          threadTs: '1795000000.000100',
          messageTs: '1795000000.000100',
          permalink,
          title: 'price the catalog in euros',
        },
      },
      agentRun: { state: 'working' },
    };
    const { cloudSessions, runs } = createDrizzleStores(harness.db.company);
    await cloudSessions.insert(session);
    const record = agentRunRecord(
      session,
      {
        factoryVersion: 1,
        text: 'A request from Slack.',
        createdAt: new Date().toISOString(),
        startedBy: owner.personId,
      },
      new Date().toISOString(),
    );
    if (record === null) throw new Error('no record');
    expect(await recordRun(runs, owner.workspaceId, record)).toMatchObject({ kind: 'recorded' });

    const read = await harness.app.request(`/api/cloud-sessions/${session.id}`, {
      headers: owner.headers,
    });
    expect(await answered(read, getCloudSession)).toEqual([200, session]);

    const run = await harness.app.request(`/api/runs/${session.id}`, { headers: owner.headers });
    const [status, body] = await answered(run, getRun);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      run: {
        kind: 'request',
        trigger: 'event',
        triggerDetail: 'slack_dm',
        startedBy: owner.personId,
        item: { url: permalink, title: 'price the catalog in euros', kind: 'slack' },
      },
      conversation: { sessionId: session.id },
    });
  });
});
