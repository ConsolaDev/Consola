import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../adapters/persistence/database.js';
import { openTestDatabase } from '../adapters/persistence/database.test-helpers.js';
import { createSlackStores } from '../adapters/persistence/slackStores.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import type { Factory } from '../domain/factory.js';
import type { InstalledSlackApp, SlackEventCallback } from '../domain/slackEvents.js';
import { fakeMembership } from './membership.test-helpers.js';
import type { FakeMembership } from './membership.test-helpers.js';
import type { Offer, RunnerChannel, SessionStartRequest } from './ports.js';
import type { LinkTokens } from './slackPorts.js';
import {
  countingTokens,
  fakeSlackApi,
  holdSprocket,
  installSlackApp,
  linkSlackUser,
  markingSealer,
  SPROCKET_SLACK,
} from './slack.test-helpers.js';
import type { FakeSlack } from './slack.test-helpers.js';
import { handleSlackEvent } from './slackRequests.js';
import type { SlackRequestPorts } from './slackRequests.js';

const NOW = 1_795_000_000;
const PUBLIC_URL = 'http://localhost:5175';

let db: Database;
let close: () => Promise<void>;
let membership: FakeMembership;
let factory: Factory;
let hidden: Factory;
let app: InstalledSlackApp;
let slack: FakeSlack;
let lines: string[];
let starts: Array<[string, SessionStartRequest]>;
let tokens: LinkTokens;

const offer: Offer = {
  runnerId: 'runner-1',
  repositories: ['sprocket/catalog-portal'],
  harnesses: ['claude'],
};

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  membership = fakeMembership();
  ({ factory, hidden } = await holdSprocket(db, membership));
  app = await installSlackApp(db, factory);
  slack = fakeSlackApi();
  lines = [];
  starts = [];
  tokens = countingTokens();
});
afterEach(async () => {
  await close();
});

function ports(connected: Offer | null = offer): SlackRequestPorts {
  const stores = createDrizzleStores(db);
  const slackStores = createSlackStores(db);
  const runners: RunnerChannel = {
    connected: () => connected,
    startSession: async (runnerId, request) => {
      starts.push([runnerId, request]);
    },
    stopSession: async () => {},
  };
  let ids = 0;
  return {
    sessions: stores.cloudSessions,
    runners,
    ids: { newId: () => `session-${++ids}` },
    clock: { nowSeconds: () => NOW },
    factories: stores.factories,
    runs: stores.runs,
    teams: stores.teams,
    membership,
    apps: slackStores.apps,
    links: slackStores.links,
    requests: slackStores.requests,
    tokens,
    slack: slack.api,
    sealer: markingSealer,
    publicUrl: PUBLIC_URL,
    report: (line) => {
      lines.push(line);
    },
  };
}

let events = 0;
/** An event Slack sent the factory's app, around `event`. */
const callbackOf = (event: Record<string, unknown>): SlackEventCallback => ({
  apiAppId: SPROCKET_SLACK.appId,
  teamId: SPROCKET_SLACK.teamId,
  eventId: `Ev0${++events}`,
  eventType: String(event.type),
  event,
});

const mention = (over: Record<string, unknown> = {}) =>
  callbackOf({
    type: 'app_mention',
    user: 'U0FAY',
    text: '<@U0BOT> price the catalog in euros',
    ts: '1795000000.000100',
    channel: 'C0CATALOG',
    ...over,
  });

const handle = (callback: SlackEventCallback, connected?: Offer | null) =>
  handleSlackEvent(ports(connected), app, callback);

/** The one reply only the author saw, and nothing posted for everyone. */
function whispered() {
  expect(slack.of('chat.postMessage')).toEqual([]);
  const [whisper, ...more] = slack.of('chat.postEphemeral');
  expect(more).toEqual([]);
  return whisper;
}

describe('who may talk to a factory', () => {
  it('refuses an author from another Slack workspace (Slack Connect), with no link', async () => {
    await linkSlackUser(db, 'U0FAY', 'person-fay');
    const outcome = await handle(mention({ user_team: 'T0GLOBEX', source_team: 'T0GLOBEX' }));
    expect(outcome).toEqual({ kind: 'slack-connect' });
    expect(whispered()).toEqual({
      method: 'chat.postEphemeral',
      token: SPROCKET_SLACK.botToken,
      args: {
        channel: 'C0CATALOG',
        user: 'U0FAY',
        text: "I take requests only from people in this app's own Slack workspace, not from other organisations in a shared channel.",
      },
    });
    expect(await createSlackStores(db).links.findRequest('hash:token-1')).toBeNull();
  });

  it('sends an unlinked author a one-time link, for them alone', async () => {
    expect(await handle(mention())).toEqual({ kind: 'link-sent' });
    const whisper = whispered();
    expect(whisper?.args.user).toBe('U0FAY');
    expect(whisper?.args.text).toBe(
      `Link your Slack account to Consola before I take your request: ${PUBLIC_URL}/#/slack/link/token-1\nThe link is yours alone, works once and lasts 15 minutes. Then send your request again.`,
    );
    expect(await createSlackStores(db).links.findRequest('hash:token-1')).toMatchObject({
      workspaceId: 'sprocket',
      factoryId: factory.id,
      slackTeamId: SPROCKET_SLACK.teamId,
      slackUserId: 'U0FAY',
      channelId: 'C0CATALOG',
      expiresAt: new Date((NOW + 15 * 60) * 1000),
      usedAt: null,
    });
  });

  it('refuses a linked person who is no longer a member, read live', async () => {
    await linkSlackUser(db, 'U0FAY', 'person-fay');
    membership.remove('sprocket', 'person-fay');
    expect(await handle(mention())).toEqual({ kind: 'not-a-member' });
    expect(whispered()?.args.text).toBe(
      "You're no longer a member of this factory's workspace in Consola, so I can't take your request.",
    );
  });

  it('refuses a member who cannot see the factory, saying who can add them to its team', async () => {
    const hiddenApp = await installSlackApp(db, hidden, 'A0PRICES');
    await linkSlackUser(db, 'U0FAY', 'person-fay');
    expect(await handleSlackEvent(ports(), hiddenApp, mention())).toEqual({ kind: 'not-seen' });
    expect(whispered()?.args.text).toBe(
      "You can't see this factory in Consola, so I can't take your request. An owner or admin of the workspace can add you to its team.",
    );
  });

  it('asks for something to do when the mention says nothing', async () => {
    await linkSlackUser(db, 'U0FAY', 'person-fay');
    expect(await handle(mention({ text: '<@U0BOT>' }))).toEqual({ kind: 'empty' });
    expect(whispered()?.args.text).toBe(
      "Tell me what you need in the same message, and I'll start on it.",
    );
  });

  it('admits a linked member who sees the factory, in a direct message too', async () => {
    await linkSlackUser(db, 'U0FAY', 'person-fay');
    await linkSlackUser(db, 'U0DANA', 'person-dana');
    expect(await handle(mention())).toMatchObject({ kind: 'admitted', personId: 'person-fay' });
    const dm = callbackOf({
      type: 'message',
      channel_type: 'im',
      user: 'U0DANA',
      text: 'Is the catalog priced in euros yet?',
      ts: '1795000000.000200',
      channel: 'D0DANA',
    });
    expect(await handle(dm)).toMatchObject({ kind: 'admitted', personId: 'person-dana' });
    expect(slack.of('chat.postEphemeral')).toEqual([]);
  });

  it("answers in the author's thread when they wrote in one, else in the channel", async () => {
    await handle(mention({ thread_ts: '1794999999.000001' }));
    expect(slack.of('chat.postEphemeral')[0]?.args.threadTs).toBe('1794999999.000001');
    await handle(mention());
    expect(slack.of('chat.postEphemeral')[1]?.args).not.toHaveProperty('threadTs');
  });
});

describe("a factory's bot", () => {
  it('drops what is no request, saying why in the log, and says nothing in Slack', async () => {
    const dropped = await handle(
      callbackOf({
        type: 'message',
        channel_type: 'channel',
        user: 'U0FAY',
        text: 'hi',
        ts: '1.2',
        channel: 'C0CATALOG',
      }),
    );
    expect(dropped).toEqual({
      kind: 'dropped',
      reason: 'a message in a channel, with no mention of the bot',
    });
    expect(slack.calls).toEqual([]);
    expect(lines.at(-1)).toMatch(
      /^Dropped Slack event Ev0\d+ \(message\) for factory .+: a message in a channel/,
    );
  });

  it('says nothing once its app needs adding to Slack again', async () => {
    await createSlackStores(db).apps.markNeedsReinstall({
      workspaceId: 'sprocket',
      factoryId: factory.id,
      appId: SPROCKET_SLACK.appId,
    });
    const marked = await createSlackStores(db).apps.get('sprocket', factory.id);
    if (marked === null || marked.install === null) throw new Error('no app');
    expect(
      await handleSlackEvent(ports(), { ...marked, install: marked.install }, mention()),
    ).toEqual({
      kind: 'no-bot',
    });
    expect(slack.calls).toEqual([]);
  });

  it('marks its app as needing adding to Slack again when Slack says its token is dead', async () => {
    slack.refuse('chat.postEphemeral', 'token_revoked');
    expect(await handle(mention())).toEqual({ kind: 'link-sent' });
    const marked = await createSlackStores(db).apps.get('sprocket', factory.id);
    expect(marked?.needsReinstall).toBe(true);
    expect(lines.some((line) => line.includes('token_revoked'))).toBe(true);
  });

  it('logs any other refusal with ids, and never what anyone wrote or a token', async () => {
    slack.refuse('chat.postEphemeral', 'channel_not_found');
    await handle(mention());
    expect((await createSlackStores(db).apps.get('sprocket', factory.id))?.needsReinstall).toBe(
      false,
    );
    for (const line of lines) {
      expect(line).not.toMatch(/price the catalog|xoxb|token-1/);
    }
    expect(lines).toContain(
      `Slack refused chat.postEphemeral for factory ${factory.id}: channel_not_found.`,
    );
  });
});
