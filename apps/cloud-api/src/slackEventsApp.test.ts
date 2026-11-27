import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';
import { postSlackEvent } from './company/adapters/http/slackEventsContract.js';
import { createSlackStores } from './company/adapters/persistence/slackStores.js';
import { createDrizzleStores } from './company/adapters/persistence/stores.js';
import { createSecretSealer } from './company/adapters/sealing/secretSealer.js';
import { startApi } from './testing/harness.js';
import type { Harness, Member } from './testing/harness.js';

// Slack's events through the whole API, as `main.ts` composes it, with Slack on: the front door
// (which leaves the route outside the origin check), the real stores, the sealer and the signature
// check. Every answer is read with the schema the contract declares for its status.

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

/** Status and body, the body read with the schema the contract declares for the status. */
async function answered(response: Response): Promise<[number, unknown]> {
  const declared = (postSlackEvent.responses as Record<number, DeclaredAnswer>)[response.status];
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
