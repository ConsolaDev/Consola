import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../adapters/persistence/database.js';
import {
  makeTestWorkspace,
  openTestDatabase,
} from '../adapters/persistence/database.test-helpers.js';
import { createSlackStores } from '../adapters/persistence/slackStores.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import { slackSignatures } from '../adapters/slack/eventSignatures.js';
import type { Factory } from '../domain/factory.js';
import type { Sealed } from '../domain/slack.js';
import type { InstalledSlackApp, SlackEventCallback } from '../domain/slackEvents.js';
import { fakeMembership } from './membership.test-helpers.js';
import { receiveSlackEvent } from './slackEvents.js';
import type { SlackEventPorts, SlackEventRequest } from './slackEvents.js';
import type { SecretSealer } from './slackPorts.js';

const NOW = 1_795_000_000;
const SIGNING_SECRET = 'sprocketsigningsecret0123456789ab';

/** Seals by marking, so a test can see what was sealed; opens only what it marked. */
const markingSealer: SecretSealer = {
  seal: (secret) => `sealed:${secret}` as Sealed,
  open: (sealed) => (sealed.startsWith('sealed:') ? sealed.slice('sealed:'.length) : null),
};

let db: Database;
let close: () => Promise<void>;
let stores: ReturnType<typeof createSlackStores>;
let factory: Factory;
let tasks: Array<() => Promise<void>>;
let handled: Array<[InstalledSlackApp, SlackEventCallback]>;

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  stores = createSlackStores(db);
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
  tasks = [];
  handled = [];
});
afterEach(async () => {
  await close();
});

function ports(over: Partial<SlackEventPorts> = {}): SlackEventPorts {
  return {
    apps: stores.apps,
    factories: createDrizzleStores(db).factories,
    events: stores.events,
    sealer: markingSealer,
    signatures: slackSignatures,
    clock: { nowSeconds: () => NOW },
    later: (task) => {
      tasks.push(task);
    },
    handle: async (app, callback) => {
      handled.push([app, callback]);
    },
    ...over,
  };
}

/** Runs what was put off until after the answer. */
async function afterTheAnswer() {
  for (const task of tasks.splice(0)) await task();
}

async function saveCredentials(signingSecret = SIGNING_SECRET) {
  await stores.apps.saveCredentials({
    workspaceId: 'sprocket',
    factoryId: factory.id,
    clientId: '1111.2222',
    clientSecret: markingSealer.seal('client-secret'),
    signingSecret: markingSealer.seal(signingSecret),
    handle: 'code-review',
    configuredBy: 'person-dana',
    at: new Date(NOW * 1000),
  });
}

async function install() {
  await saveCredentials();
  const installed = await stores.apps.install({
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
  expect(installed).toBe('installed');
}

const encoder = new TextEncoder();

/** A request to the factory's address, signed as Slack signs one unless told otherwise. */
function request(
  body: unknown,
  over: { factoryId?: string; timestamp?: number; secret?: string; signature?: string } = {},
): SlackEventRequest {
  const bytes = encoder.encode(typeof body === 'string' ? body : JSON.stringify(body));
  const timestamp = String(over.timestamp ?? NOW);
  const signature =
    over.signature ??
    `v0=${createHmac('sha256', over.secret ?? SIGNING_SECRET)
      .update(`v0:${timestamp}:`)
      .update(bytes)
      .digest('hex')}`;
  return { factoryId: over.factoryId ?? factory.id, body: bytes, timestamp, signature };
}

const challenge = { type: 'url_verification', token: 'x', challenge: 'c0ffee' };

const mentionEvent = {
  type: 'app_mention',
  user: 'U0ALICE',
  text: '<@U0BOT> price the catalog in euros',
  ts: '1795000000.000100',
  channel: 'C0CATALOG',
  event_ts: '1795000000.000100',
};

const callback = (over: Record<string, unknown> = {}) => ({
  type: 'event_callback',
  team_id: 'T0SPROCKET',
  api_app_id: 'A0SPROCKET',
  event_id: 'Ev0MENTION',
  event_time: NOW,
  event: mentionEvent,
  ...over,
});

describe('receiveSlackEvent, before the factory has a signing secret', () => {
  it("answers Slack's check of the URL, unchecked, and nothing else", async () => {
    const unsigned = { factoryId: factory.id, timestamp: undefined, signature: undefined };
    const body = encoder.encode(JSON.stringify(challenge));
    expect(await receiveSlackEvent(ports(), { ...unsigned, body })).toEqual({
      kind: 'challenge',
      factoryId: factory.id,
      challenge: 'c0ffee',
      checked: false,
    });
    expect(await receiveSlackEvent(ports(), request(callback()))).toEqual({
      kind: 'not-set-up',
      factoryId: factory.id,
    });
    expect(await receiveSlackEvent(ports(), request('not json'))).toEqual({
      kind: 'not-set-up',
      factoryId: factory.id,
    });
    expect(tasks).toEqual([]);
  });

  it('refuses an address that names no factory, whatever it sends', async () => {
    for (const body of [challenge, callback()]) {
      expect(await receiveSlackEvent(ports(), request(body, { factoryId: 'no-such' }))).toEqual({
        kind: 'unknown-factory',
      });
    }
  });
});

describe('receiveSlackEvent, once the factory has a signing secret', () => {
  beforeEach(() => saveCredentials());

  it('checks the signature before anything else, the check of the URL included', async () => {
    for (const body of [challenge, callback(), 'not json']) {
      expect(await receiveSlackEvent(ports(), request(body, { secret: 'another' }))).toEqual({
        kind: 'bad-signature',
        factoryId: factory.id,
        why: 'mismatch',
      });
      expect(await receiveSlackEvent(ports(), request(body, { timestamp: NOW - 301 }))).toEqual({
        kind: 'bad-signature',
        factoryId: factory.id,
        why: 'stale',
      });
    }
    const unsigned = { factoryId: factory.id, timestamp: String(NOW), signature: undefined };
    expect(
      await receiveSlackEvent(ports(), { ...unsigned, body: encoder.encode('{}') }),
    ).toMatchObject({ kind: 'bad-signature', why: 'mismatch' });
  });

  it("answers Slack's check of the URL once it is signed", async () => {
    expect(await receiveSlackEvent(ports(), request(challenge))).toEqual({
      kind: 'challenge',
      factoryId: factory.id,
      challenge: 'c0ffee',
      checked: true,
    });
  });

  it('refuses a signed body Slack would not send, and ignores what Consola does not take', async () => {
    expect(await receiveSlackEvent(ports(), request('not json'))).toEqual({
      kind: 'invalid',
      factoryId: factory.id,
      reason: 'its body is not a JSON object',
    });
    expect(await receiveSlackEvent(ports(), request({ type: 'app_rate_limited' }))).toEqual({
      kind: 'ignored',
      factoryId: factory.id,
      type: 'app_rate_limited',
    });
  });

  it('takes no event before the app is added to a Slack workspace', async () => {
    expect(await receiveSlackEvent(ports(), request(callback()))).toEqual({
      kind: 'not-installed',
      factoryId: factory.id,
    });
    expect(tasks).toEqual([]);
  });

  it("is unavailable when the secret does not open with this server's key", async () => {
    const otherKey: SecretSealer = { ...markingSealer, open: () => null };
    expect(await receiveSlackEvent(ports({ sealer: otherKey }), request(callback()))).toEqual({
      kind: 'unavailable',
      factoryId: factory.id,
      reason: "its signing secret does not open with this server's CONNECTION_SECRETS_KEY",
    });
  });
});

describe('receiveSlackEvent, once the app is added to a Slack workspace', () => {
  beforeEach(() => install());

  it('accepts an event at once, and hands it on only after the answer', async () => {
    expect(await receiveSlackEvent(ports(), request(callback()))).toEqual({
      kind: 'accepted',
      factoryId: factory.id,
      eventId: 'Ev0MENTION',
      eventType: 'app_mention',
    });
    expect(handled).toEqual([]);
    await afterTheAnswer();
    expect(handled).toHaveLength(1);
    const [[app, event] = []] = handled;
    expect(app?.factoryId).toBe(factory.id);
    expect(app?.install.botUserId).toBe('U0BOT');
    expect(event).toEqual({
      apiAppId: 'A0SPROCKET',
      teamId: 'T0SPROCKET',
      eventId: 'Ev0MENTION',
      eventType: 'app_mention',
      event: mentionEvent,
      sharedChannel: false,
    });
  });

  it('ignores what release 1 does not handle before recording anything, and hands nothing on', async () => {
    const posted = {
      type: 'message',
      channel_type: 'channel',
      user: 'U0ALICE',
      text: 'lunch?',
      ts: '1795000000.000200',
      channel: 'C0CATALOG',
    };
    const fromTheBot = { ...mentionEvent, user: 'U0BOT', bot_id: 'B0BOT' };
    for (const [event, reason] of [
      [{ type: 'reaction_added', user: 'U0ALICE', reaction: 'eyes' }, 'a reaction'],
      [{ type: 'member_joined_channel', user: 'U0ALICE' }, 'someone joined a channel'],
      [posted, 'a message in a channel, with no mention of the bot'],
      [fromTheBot, 'a bot wrote it'],
    ] as const) {
      expect(
        await receiveSlackEvent(ports(), request(callback({ event_id: 'Ev0OTHER', event }))),
      ).toEqual({
        kind: 'ignored',
        factoryId: factory.id,
        type: event.type,
        reason,
      });
    }
    await afterTheAnswer();
    expect(handled).toEqual([]);
    // Nothing recorded: the id is new to the factory still.
    expect(
      await receiveSlackEvent(ports(), request(callback({ event_id: 'Ev0OTHER' }))),
    ).toMatchObject({
      kind: 'accepted',
    });
  });

  it('changes nothing for an event Slack sends again, however it was signed', async () => {
    expect(await receiveSlackEvent(ports(), request(callback()))).toMatchObject({
      kind: 'accepted',
    });
    expect(await receiveSlackEvent(ports(), request(callback(), { timestamp: NOW + 60 }))).toEqual({
      kind: 'duplicate',
      factoryId: factory.id,
      eventId: 'Ev0MENTION',
      eventType: 'app_mention',
    });
    await afterTheAnswer();
    expect(handled).toHaveLength(1);
  });

  it("refuses an event for another app or Slack workspace, signed with this factory's secret", async () => {
    for (const other of [{ api_app_id: 'A0OTHER' }, { team_id: 'T0OTHER' }]) {
      expect(await receiveSlackEvent(ports(), request(callback(other)))).toEqual({
        kind: 'wrong-app',
        factoryId: factory.id,
        eventId: 'Ev0MENTION',
      });
    }
    // Refused, so not recorded: the right one is still taken.
    expect(await receiveSlackEvent(ports(), request(callback()))).toMatchObject({
      kind: 'accepted',
    });
  });

  it('is unavailable when the database does not answer', async () => {
    await close();
    expect(await receiveSlackEvent(ports(), request(callback()))).toMatchObject({
      kind: 'unavailable',
      factoryId: null,
    });
    // The suite's own close then finds it closed.
    ({ db, close } = await openTestDatabase());
  });
});
