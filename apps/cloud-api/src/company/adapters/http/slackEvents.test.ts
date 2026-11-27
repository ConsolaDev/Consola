import { createHmac } from 'node:crypto';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { fakeMembership } from '../../application/membership.test-helpers.js';
import type { SlackEventPorts } from '../../application/slackEvents.js';
import type { SecretSealer } from '../../application/slackPorts.js';
import type { Factory } from '../../domain/factory.js';
import type { Sealed } from '../../domain/slack.js';
import { SLACK_EVENT_MAX_BYTES } from '../../domain/slackEvents.js';
import type { Database } from '../persistence/database.js';
import { makeTestWorkspace, openTestDatabase } from '../persistence/database.test-helpers.js';
import { createSlackStores } from '../persistence/slackStores.js';
import { createDrizzleStores } from '../persistence/stores.js';
import { slackSignatures } from '../slack/eventSignatures.js';
import { registerSlackEventRoutes, SLACK_EVENT_ROUTES } from './slackEvents.js';
import { postSlackEvent } from './slackEventsContract.js';

// Slack's events route on an app of its own, as the composition registers it, on the real stores.
// The whole API, with the front door, is the composition's suite (`src/slackEventsApp.test.ts`).

const NOW = 1_795_000_000;
const SIGNING_SECRET = 'sprocketsigningsecret0123456789ab';

const markingSealer: SecretSealer = {
  seal: (secret) => `sealed:${secret}` as Sealed,
  open: (sealed) => (sealed.startsWith('sealed:') ? sealed.slice('sealed:'.length) : null),
};

let db: Database;
let close: () => Promise<void>;
let factory: Factory;
let lines: string[];
let handled: string[];

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  await makeTestWorkspace(db, fakeMembership(), 'sprocket', [['person-dana', 'owner']]);
  const { teams, factories } = createDrizzleStores(db);
  const [first] = await teams.list('sprocket');
  if (!first) throw new Error('Sprocket has no first team');
  const made = await factories.create('sprocket', {
    name: 'Code review',
    teamId: first.id,
    personId: 'person-dana',
  });
  if (typeof made === 'string') throw new Error(made);
  factory = made;
  lines = [];
  handled = [];
});
afterEach(async () => {
  await close();
});

function build(on = true) {
  const stores = createSlackStores(db);
  const ports: SlackEventPorts = {
    apps: stores.apps,
    factories: createDrizzleStores(db).factories,
    events: stores.events,
    sealer: markingSealer,
    signatures: slackSignatures,
    clock: { nowSeconds: () => NOW },
    later: (task) => {
      void task();
    },
    handle: async (_app, callback) => {
      handled.push(callback.eventId);
    },
  };
  const app = new OpenAPIHono();
  const log = (line: string) => {
    lines.push(line);
  };
  registerSlackEventRoutes(app, {
    slack: on ? ports : null,
    log: { debug: log, info: log, warn: log },
  });
  return { app, stores };
}

async function install(stores: ReturnType<typeof createSlackStores>) {
  await stores.apps.saveCredentials({
    workspaceId: 'sprocket',
    factoryId: factory.id,
    clientId: '1111.2222',
    clientSecret: markingSealer.seal('client-secret'),
    signingSecret: markingSealer.seal(SIGNING_SECRET),
    handle: 'code-review',
    configuredBy: 'person-dana',
    at: new Date(NOW * 1000),
  });
  await stores.apps.install({
    workspaceId: 'sprocket',
    factoryId: factory.id,
    clientId: '1111.2222',
    install: {
      appId: 'A0SPROCKET',
      teamId: 'T0SPROCKET',
      teamName: 'Sprocket',
      botUserId: 'U0BOT',
      installedBy: 'person-dana',
      installedAt: new Date(NOW * 1000),
    },
    botToken: markingSealer.seal('xoxb-sprocket'),
    handle: 'code-review',
  });
}

type DeclaredAnswer = { content?: Record<string, { schema: ZodType }> };

/** The answer's body, read with the schema the contract declares for its status. */
async function answerOf(response: Response): Promise<unknown> {
  const declared = (postSlackEvent.responses as Record<number, DeclaredAnswer>)[response.status];
  expect(declared, `the contract declares ${response.status}`).toBeDefined();
  const schema = declared?.content?.['application/json']?.schema;
  if (!schema) throw new Error(`${response.status} declares no body`);
  return schema.parse(await response.json());
}

/** POSTs `body` to `factoryId`'s address, signed with `secret` unless told not to sign. */
function send(
  app: OpenAPIHono,
  body: unknown,
  options: { factoryId?: string; secret?: string | null } = {},
) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = new Headers({ 'content-type': 'application/json' });
  const secret = options.secret === undefined ? SIGNING_SECRET : options.secret;
  if (secret !== null) {
    headers.set('x-slack-request-timestamp', String(NOW));
    const hmac = createHmac('sha256', secret).update(`v0:${NOW}:${text}`).digest('hex');
    headers.set('x-slack-signature', `v0=${hmac}`);
  }
  return app.request(`/api/slack/events/${options.factoryId ?? factory.id}`, {
    method: 'POST',
    headers,
    body: text,
  });
}

const challenge = { type: 'url_verification', token: 'x', challenge: 'c0ffee-challenge' };
const callback = (over: Record<string, unknown> = {}) => ({
  type: 'event_callback',
  team_id: 'T0SPROCKET',
  api_app_id: 'A0SPROCKET',
  event_id: 'Ev0MENTION',
  event: {
    type: 'app_mention',
    user: 'U0ALICE',
    text: '<@U0BOT> price the catalog in euros',
    ts: '1795000000.000100',
    channel: 'C0CATALOG',
  },
  ...over,
});

describe("Slack's events route", () => {
  it('is the one route it registers', () => {
    expect(SLACK_EVENT_ROUTES).toEqual([postSlackEvent]);
  });

  it('answers each outcome with its status, as the contract declares it', async () => {
    const { app, stores } = build();
    const asked = async (response: Response) => [response.status, await answerOf(response)];

    expect(await asked(await send(app, challenge, { factoryId: 'no-such' }))).toEqual([
      404,
      { error: 'factory_not_found' },
    ]);
    expect(await asked(await send(app, challenge, { secret: null }))).toEqual([
      200,
      { challenge: 'c0ffee-challenge' },
    ]);
    expect(await asked(await send(app, callback()))).toEqual([409, { error: 'slack_not_set_up' }]);

    await install(stores);
    expect(await asked(await send(app, callback(), { secret: 'another' }))).toEqual([
      401,
      { error: 'bad_signature' },
    ]);
    expect(await asked(await send(app, 'not json'))).toEqual([400, { error: 'invalid_event' }]);
    expect(await asked(await send(app, { type: 'app_rate_limited' }))).toEqual([
      200,
      { result: 'ignored' },
    ]);
    expect(await asked(await send(app, callback({ team_id: 'T0OTHER' })))).toEqual([
      403,
      { error: 'wrong_app' },
    ]);
    expect(await asked(await send(app, callback()))).toEqual([200, { result: 'accepted' }]);
    expect(await asked(await send(app, callback()))).toEqual([200, { result: 'duplicate' }]);
    expect(handled).toEqual(['Ev0MENTION']);
  });

  it('answers an event release 1 does not handle, records nothing and logs it at debug level', async () => {
    const { stores } = build();
    await install(stores);
    const debug: string[] = [];
    const quiet = new OpenAPIHono();
    registerSlackEventRoutes(quiet, {
      slack: {
        apps: stores.apps,
        factories: createDrizzleStores(db).factories,
        events: stores.events,
        sealer: markingSealer,
        signatures: slackSignatures,
        clock: { nowSeconds: () => NOW },
        later: () => {},
        handle: async () => {},
      },
      log: {
        debug: (line: string) => debug.push(line),
        info: (line: string) => lines.push(line),
        warn: (line: string) => lines.push(line),
      },
    });
    const reaction = callback({
      event_id: 'Ev0REACTION',
      event: { type: 'reaction_added', user: 'U0ALICE', reaction: 'eyes' },
    });
    const channelMessage = callback({
      event_id: 'Ev0CHANNEL',
      event: {
        type: 'message',
        channel_type: 'channel',
        user: 'U0ALICE',
        text: 'lunch?',
        ts: '1795000000.000200',
        channel: 'C0CATALOG',
      },
    });
    for (const body of [reaction, reaction, channelMessage]) {
      const response = await send(quiet, body);
      expect([response.status, await answerOf(response)]).toEqual([200, { result: 'ignored' }]);
    }
    expect(lines).toEqual([]);
    expect(debug).toEqual([
      `Ignored Slack's reaction_added for factory ${factory.id}: a reaction.`,
      `Ignored Slack's reaction_added for factory ${factory.id}: a reaction.`,
      `Ignored Slack's message for factory ${factory.id}: a message in a channel, with no mention of the bot.`,
    ]);
    // Never recorded: the same id is still new to the factory.
    expect(
      await stores.events.record({
        workspaceId: 'sprocket',
        factoryId: factory.id,
        eventId: 'Ev0REACTION',
        at: new Date(NOW * 1000),
      }),
    ).toBe('recorded');
    expect(handled).toEqual([]);
  });

  it('says an app not added to Slack yet takes no event', async () => {
    const { app, stores } = build();
    await install(stores);
    await stores.apps.forget('sprocket', factory.id);
    await stores.apps.saveCredentials({
      workspaceId: 'sprocket',
      factoryId: factory.id,
      clientId: '1111.2222',
      clientSecret: markingSealer.seal('client-secret'),
      signingSecret: markingSealer.seal(SIGNING_SECRET),
      handle: 'code-review',
      configuredBy: 'person-dana',
      at: new Date(NOW * 1000),
    });
    const response = await send(app, callback());
    expect([response.status, await answerOf(response)]).toEqual([
      409,
      { error: 'slack_not_installed' },
    ]);
  });

  it('refuses every event while Slack is off', async () => {
    const { app } = build(false);
    const response = await send(app, challenge);
    expect([response.status, await answerOf(response)]).toEqual([
      503,
      { error: 'slack_not_configured' },
    ]);
  });

  it('refuses a body over the limit before reading it', async () => {
    const { app } = build();
    const response = await send(app, 'x'.repeat(SLACK_EVENT_MAX_BYTES + 1));
    expect([response.status, await answerOf(response)]).toEqual([413, { error: 'too_large' }]);
  });

  it('logs one line per request, with ids and never a challenge, a body or a secret', async () => {
    const { app, stores } = build();
    await send(app, challenge, { secret: null });
    await send(app, challenge, { factoryId: 'forged\nline' });
    await install(stores);
    await send(app, challenge);
    await send(app, callback({ team_id: 'T0OTHER' }));
    await send(app, callback());
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(line).not.toMatch(/c0ffee|price the catalog|sprocketsigningsecret|xoxb|forged/);
      expect(line).not.toContain('\n');
    }
    expect(lines.at(-1)).toBe(
      `Accepted Slack event Ev0MENTION (app_mention) for factory ${factory.id}.`,
    );
  });
});
