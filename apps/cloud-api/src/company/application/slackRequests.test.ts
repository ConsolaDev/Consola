import { CODE_REVIEW_TEAM_FILES } from '@consola/factory-spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../adapters/persistence/database.js';
import { openTestDatabase } from '../adapters/persistence/database.test-helpers.js';
import { createSlackStores } from '../adapters/persistence/slackStores.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import type { Factory, FactoryFile } from '../domain/factory.js';
import type { InstalledSlackApp, SlackEventCallback } from '../domain/slackEvents.js';
import { callerAs, fakeMembership } from './membership.test-helpers.js';
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
import { readRun } from './runs.js';
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
let sessionIds: number;
let clockNow: number;
let unreachable: boolean;

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
  sessionIds = 0;
  clockNow = NOW;
  unreachable = false;
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
      if (unreachable) throw new Error('The socket is closed.');
      starts.push([runnerId, request]);
    },
    stopSession: async () => {},
  };
  return {
    sessions: stores.cloudSessions,
    runners,
    ids: { newId: () => `session-${++sessionIds}` },
    clock: { nowSeconds: () => clockNow },
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
  sharedChannel: false,
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

  it('refuses an author the event places nowhere in a channel shared with another organisation', async () => {
    await linkSlackUser(db, 'U0FAY', 'person-fay');
    const shared = { ...mention(), sharedChannel: true };
    expect(await handle(shared)).toEqual({ kind: 'slack-connect' });
    // Placed in the app's own Slack workspace, they are taken there too.
    const placed = { ...mention({ user_team: 'T0SPROCKET' }), sharedChannel: true };
    expect(await handle(placed)).toEqual({ kind: 'no-orchestrator' });
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

  it('sends one link at a time: writing again points to the one still open', async () => {
    expect(await handle(mention())).toEqual({ kind: 'link-sent' });
    clockNow = NOW + 14 * 60;
    expect(await handle(mention({ ts: '1795000840.000100' }))).toEqual({ kind: 'link-pending' });
    const [, again] = slack.of('chat.postEphemeral');
    expect(again?.args.text).toBe(
      'I sent you a link a moment ago; it works for 15 minutes. Open it, then send your request again.',
    );
    const links = createSlackStores(db).links;
    expect(await links.findRequest('hash:token-1')).not.toBeNull();
    expect(await links.findRequest('hash:token-2')).toBeNull();

    // Another channel is another link; so is the same one once the first has expired.
    expect(await handle(mention({ channel: 'C0PRICING' }))).toEqual({ kind: 'link-sent' });
    clockNow = NOW + 15 * 60;
    expect(await handle(mention({ ts: '1795000900.000100' }))).toEqual({ kind: 'link-sent' });
    expect(await links.findRequest('hash:token-3')).toMatchObject({ channelId: 'C0CATALOG' });
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

  it('lets a linked member who sees the factory on, in a direct message too', async () => {
    await linkSlackUser(db, 'U0FAY', 'person-fay');
    await linkSlackUser(db, 'U0DANA', 'person-dana');
    // On, to the start's own checks: this factory's files hold no orchestrator yet.
    expect(await handle(mention())).toEqual({ kind: 'no-orchestrator' });
    const dm = callbackOf({
      type: 'message',
      channel_type: 'im',
      user: 'U0DANA',
      text: 'Is the catalog priced in euros yet?',
      ts: '1795000000.000200',
      channel: 'D0DANA',
    });
    expect(await handle(dm)).toEqual({ kind: 'no-orchestrator' });
    expect(slack.of('chat.postEphemeral')).toEqual([]);
  });

  it('answers an author in a direct message with a message there, in their thread if any', async () => {
    const dm = (over: Record<string, unknown> = {}) =>
      callbackOf({
        type: 'message',
        channel_type: 'im',
        user: 'U0BOB',
        text: 'Is the catalog priced in euros yet?',
        ts: '1795000000.000300',
        channel: 'D0BOB',
        ...over,
      });
    expect(await handle(dm())).toEqual({ kind: 'link-sent' });
    expect(await handle(dm({ ts: '1795000000.000400', thread_ts: '1795000000.000300' }))).toEqual({
      kind: 'link-pending',
    });
    expect(slack.of('chat.postEphemeral')).toEqual([]);
    const [first, second] = slack.of('chat.postMessage').map((call) => call.args);
    expect(first).toMatchObject({ channel: 'D0BOB' });
    expect(first).not.toHaveProperty('threadTs');
    expect(String(first?.text)).toMatch(/^Link your Slack account to Consola/);
    expect(second).toMatchObject({ channel: 'D0BOB', threadTs: '1795000000.000300' });
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

/** The factory's next version holds `files`. */
async function saveFiles(files: readonly FactoryFile[]) {
  const { factories } = createDrizzleStores(db);
  const latest = await factories.get('sprocket', factory.id);
  if (latest === null) throw new Error('no factory');
  const saved = await factories.save('sprocket', factory.id, {
    baseVersion: latest.latestVersion,
    files,
    personId: 'person-dana',
  });
  if (saved.kind !== 'saved') throw new Error(saved.kind);
}

const REPOS = { path: 'factory.yml', content: 'version: 1\nrepos: [Sprocket/Catalog-Portal]\n' };
const TEAM_FILES: FactoryFile[] = [...CODE_REVIEW_TEAM_FILES, REPOS];
const PERMALINK = 'https://sprocket.slack.com/archives/C0CATALOG/p1795000000000100';

/** What the bot posted for everyone, in order: in which thread, and what it said. */
const postedInThreads = () =>
  slack.of('chat.postMessage').map(({ args }) => [args.channel, args.threadTs, args.text]);

describe('starting a request from Slack', () => {
  beforeEach(async () => {
    await linkSlackUser(db, 'U0FAY', 'person-fay');
  });

  it('records the session, its thread and its run, hands it to the runner, and says so', async () => {
    await saveFiles(TEAM_FILES);
    const outcome = await handle(
      mention({ text: '<@U0BOT> price the catalog in euros\nSee #42.' }),
    );

    const session = {
      id: 'session-1',
      workspaceId: 'sprocket',
      personId: null,
      repository: 'sprocket/catalog-portal',
      harness: 'claude',
      status: 'starting',
      title: 'Code review · Slack: price the catalog in euros',
      hostUrl: null,
      error: null,
      errorCode: null,
      runnerId: 'runner-1',
      createdAt: NOW,
      endedAt: null,
      origin: {
        kind: 'slack',
        factoryId: factory.id,
        factoryName: 'Code review',
        agent: 'orchestrator',
        via: 'mention',
        message: {
          teamId: 'T0SPROCKET',
          channelId: 'C0CATALOG',
          threadTs: '1795000000.000100',
          messageTs: '1795000000.000100',
          permalink: PERMALINK,
          title: 'price the catalog in euros',
        },
      },
      agentRun: null,
    };
    expect(outcome).toEqual({ kind: 'started', session });
    expect(await createDrizzleStores(db).cloudSessions.find('session-1')).toEqual(session);

    expect(await createSlackStores(db).requests.ofSession('session-1')).toEqual({
      workspaceId: 'sprocket',
      sessionId: 'session-1',
      factoryId: factory.id,
      slackTeamId: 'T0SPROCKET',
      channelId: 'C0CATALOG',
      threadTs: '1795000000.000100',
      messageTs: '1795000000.000100',
      startedBy: 'person-fay',
      posted: null,
      createdAt: new Date(NOW * 1000),
    });

    const { teams, factories, runs } = createDrizzleStores(db);
    const read = await readRun(
      teams,
      factories,
      runs,
      callerAs('person-fay', 'member', 'sprocket'),
      'session-1',
    );
    if (read.kind !== 'found') throw new Error(read.kind);
    expect(read.run).toMatchObject({
      kind: 'request',
      title: 'price the catalog in euros',
      status: 'queued',
      trigger: 'event',
      triggerDetail: 'slack_mention',
      startedBy: 'person-fay',
      item: {
        url: PERMALINK,
        title: 'price the catalog in euros',
        kind: 'slack',
        repo: null,
        number: null,
      },
    });
    expect(read).toMatchObject({ conversation: 'session-1' });

    const [[runnerId, start] = []] = starts;
    expect(runnerId).toBe('runner-1');
    expect(start).toMatchObject({
      sessionId: 'session-1',
      workspaceId: 'sprocket',
      repository: 'sprocket/catalog-portal',
      harness: 'claude',
      agentRun: { agent: 'orchestrator' },
    });
    expect(start?.agentRun).not.toHaveProperty('checkout');
    expect(start?.agentRun?.prompt).toContain('# Request from Slack');
    expect(start?.agentRun?.prompt).toContain('```text\nprice the catalog in euros\nSee #42.\n```');
    expect(start?.agentRun?.prompt).toContain(`- Message: ${PERMALINK}`);

    expect(slack.calls.map((call) => call.method)).toEqual([
      'chat.getPermalink',
      'reactions.add',
      'chat.postMessage',
    ]);
    expect(slack.of('reactions.add')[0]?.args).toEqual({
      channel: 'C0CATALOG',
      timestamp: '1795000000.000100',
      name: 'eyes',
    });
    expect(postedInThreads()).toEqual([
      [
        'C0CATALOG',
        '1795000000.000100',
        `On it. Follow along in Consola: ${PUBLIC_URL}/#/runs/session-1`,
      ],
    ]);
  });

  it('starts one from a direct message too, answering under it', async () => {
    await linkSlackUser(db, 'U0DANA', 'person-dana');
    await saveFiles(TEAM_FILES);
    const dm = callbackOf({
      type: 'message',
      channel_type: 'im',
      user: 'U0DANA',
      text: 'Is the catalog priced in euros yet?',
      ts: '1795000000.000200',
      channel: 'D0DANA',
    });
    const outcome = await handle(dm);
    expect(outcome).toMatchObject({
      kind: 'started',
      session: {
        origin: { via: 'dm', message: { channelId: 'D0DANA', threadTs: '1795000000.000200' } },
      },
    });
    const { teams, factories, runs } = createDrizzleStores(db);
    const read = await readRun(
      teams,
      factories,
      runs,
      callerAs('person-dana', 'owner', 'sprocket'),
      'session-1',
    );
    expect(read).toMatchObject({
      kind: 'found',
      run: { triggerDetail: 'slack_dm', startedBy: 'person-dana' },
    });
    expect(postedInThreads()[0]?.slice(0, 2)).toEqual(['D0DANA', '1795000000.000200']);
  });

  it('says in the thread that a factory with no orchestrator in its files takes no request', async () => {
    expect(await handle(mention())).toEqual({ kind: 'no-orchestrator' });
    await saveFiles([REPOS]);
    expect(await handle(mention())).toEqual({ kind: 'no-orchestrator' });
    const words = `This factory has no orchestrator in its files, so it can't take requests from Slack yet: ${PUBLIC_URL}/#/factories/${factory.id}/definition`;
    expect(postedInThreads()).toEqual([
      ['C0CATALOG', '1795000000.000100', words],
      ['C0CATALOG', '1795000000.000100', words],
    ]);
    expect(starts).toEqual([]);
    expect(await createDrizzleStores(db).cloudSessions.find('session-1')).toBeNull();
  });

  it('says in the thread that a factory listing no repository takes no request', async () => {
    await saveFiles(CODE_REVIEW_TEAM_FILES);
    expect(await handle(mention())).toEqual({ kind: 'no-repository' });
    expect(postedInThreads()).toEqual([
      [
        'C0CATALOG',
        '1795000000.000100',
        `This factory lists no repository to work in. Add one to \`repos:\` in its factory.yml: ${PUBLIC_URL}/#/factories/${factory.id}/definition`,
      ],
    ]);
  });

  it("says in the thread why the runner cannot take it, in the words an automation's run gets", async () => {
    await saveFiles(TEAM_FILES);
    expect(await handle(mention(), null)).toEqual({ kind: 'runner_unavailable' });
    expect(await handle(mention(), { ...offer, repositories: ['sprocket/catalog-api'] })).toEqual({
      kind: 'repository_not_offered',
    });
    expect(await handle(mention(), { ...offer, harnesses: ['codex'] })).toEqual({
      kind: 'harness_not_offered',
    });
    expect(postedInThreads().map(([, , text]) => text)).toEqual([
      'No runner was connected for this workspace, so nothing ran.',
      'The runner does not offer this repository, so nothing ran.',
      "The runner does not offer the first agent's harness, so nothing ran.",
    ]);
    expect(starts).toEqual([]);
  });

  it('starts nothing more in a thread whose request is open, and answers with its run', async () => {
    await saveFiles(TEAM_FILES);
    expect(await handle(mention())).toMatchObject({ kind: 'started' });
    const reply = mention({ ts: '1795000050.000100', thread_ts: '1795000000.000100' });
    expect(await handle(reply)).toEqual({ kind: 'already-running' });
    expect(postedInThreads().at(-1)).toEqual([
      'C0CATALOG',
      '1795000000.000100',
      `This thread already has a request running: ${PUBLIC_URL}/#/runs/session-1`,
    ]);
    // Another thread starts its own.
    expect(await handle(mention({ ts: '1795000060.000100' }))).toMatchObject({
      kind: 'started',
      session: { id: 'session-2' },
    });
    // Once the first has ended, its thread may start another.
    await createDrizzleStores(db).cloudSessions.update('session-1', 'starting', {
      status: 'stopped',
      endedAt: NOW + 60,
    });
    expect(
      await handle(mention({ ts: '1795000070.000100', thread_ts: '1795000000.000100' })),
    ).toMatchObject({
      kind: 'started',
      session: { id: 'session-3', origin: { message: { threadTs: '1795000000.000100' } } },
    });
  });

  it('starts nothing when Slack gives no permalink for the message', async () => {
    await saveFiles(TEAM_FILES);
    slack.fail('chat.getPermalink');
    expect(await handle(mention())).toEqual({ kind: 'no-permalink' });
    expect(postedInThreads().map(([, , text]) => text)).toEqual([
      "I couldn't read this message's link from Slack, so nothing started. Try again in a moment.",
    ]);
    expect(starts).toEqual([]);
  });

  it('starts nothing when the plan cannot be read, and logs why', async () => {
    await saveFiles(TEAM_FILES);
    expect(await handle(mention({ text: `<@U0BOT> ${'x'.repeat(270_000)}` }))).toEqual({
      kind: 'agent_run_invalid',
    });
    expect(postedInThreads().map(([, , text]) => text)).toEqual([
      'The run could not be planned from its factory files, so nothing ran.',
    ]);
    expect(lines.some((line) => line.includes('the protocol refuses the start'))).toBe(true);
    expect(await createDrizzleStores(db).cloudSessions.find('session-1')).toBeNull();
  });

  it('says nothing of a start its runner could not be told of, which the session ends', async () => {
    await saveFiles(TEAM_FILES);
    unreachable = true;
    expect(await handle(mention())).toMatchObject({
      kind: 'started',
      session: { id: 'session-1', status: 'failed', errorCode: 'runner_unreachable' },
    });
    expect(slack.calls.map((call) => call.method)).toEqual(['chat.getPermalink']);
  });

  it('logs ids alone, never what the person wrote', async () => {
    await saveFiles(TEAM_FILES);
    await handle(mention());
    await handle(mention({ ts: '1795000050.000100', thread_ts: '1795000000.000100' }));
    for (const line of lines) expect(line).not.toMatch(/price the catalog|xoxb/);
    expect(lines).toContain(
      `Started the request of Slack user U0FAY to factory ${factory.id} as run session-1.`,
    );
  });
});

describe('when something fails once Slack has its answer', () => {
  beforeEach(async () => {
    await linkSlackUser(db, 'U0FAY', 'person-fay');
    await saveFiles(TEAM_FILES);
  });

  it('ends a session it recorded, so its run says why, and tells the person', async () => {
    const base = ports();
    const failing: SlackRequestPorts = {
      ...base,
      requests: {
        ...base.requests,
        record: async () => {
          throw new Error('Connection terminated unexpectedly');
        },
      },
    };
    const outcome = await handleSlackEvent(failing, app, mention());
    expect(outcome).toMatchObject({
      kind: 'start-failed',
      session: { id: 'session-1', status: 'failed', errorCode: 'runner_unreachable', endedAt: NOW },
    });
    expect(await createDrizzleStores(db).cloudSessions.find('session-1')).toMatchObject({
      status: 'failed',
      errorCode: 'runner_unreachable',
    });
    const { teams, factories, runs } = createDrizzleStores(db);
    const read = await readRun(
      teams,
      factories,
      runs,
      callerAs('person-fay', 'member', 'sprocket'),
      'session-1',
    );
    expect(read).toMatchObject({
      kind: 'found',
      run: {
        status: 'failed',
        error: 'The cell could not hand this run to its runner.',
        startedBy: 'person-fay',
      },
    });
    expect(starts).toEqual([]);
    expect(postedInThreads()).toEqual([
      [
        'C0CATALOG',
        '1795000000.000100',
        'Something went wrong starting this request. Please try again.',
      ],
    ]);
    expect(lines).toContain(
      `Could not start the request of Slack user U0FAY to factory ${factory.id} as run session-1: Connection terminated unexpectedly.`,
    );
  });

  it('tells the person when it fails before any session exists, and records none', async () => {
    const base = ports();
    const failing: SlackRequestPorts = {
      ...base,
      factories: {
        ...base.factories,
        version: async () => {
          throw new Error('Connection terminated unexpectedly');
        },
      },
    };
    expect(await handleSlackEvent(failing, app, mention())).toEqual({ kind: 'failed' });
    expect(await createDrizzleStores(db).cloudSessions.find('session-1')).toBeNull();
    expect(postedInThreads()).toEqual([
      [
        'C0CATALOG',
        '1795000000.000100',
        'Something went wrong starting this request. Please try again.',
      ],
    ]);
  });
});
