import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  SlackAppStore,
  SlackCredentials,
  SlackEventStore,
  SlackLinkStore,
  SlackRequestStore,
} from '../../application/slackPorts.js';
import type { Factory } from '../../domain/factory.js';
import type {
  Sealed,
  SlackInstall,
  SlackLinkRequest,
  SlackRequestThread,
} from '../../domain/slack.js';
import { createCloudSessionStore } from './cloudSessions.js';
import type { Database } from './database.js';
import { openTestDatabase } from './database.test-helpers.js';
import { createFactoryStore } from './factories.js';
import { createSlackStores } from './slackStores.js';
import { createTeamStore, openWorkspace } from './teams.js';

let db: Database;
let close: () => Promise<void>;
let apps: SlackAppStore;
let links: SlackLinkStore;
let events: SlackEventStore;
let requests: SlackRequestStore;

const at = (iso: string) => new Date(iso);
const sealed = (text: string) => `sealed:${text}` as Sealed;

/** A factory of a workspace made as making one does, on its first team. */
async function factoryOf(workspaceId: string, name: string): Promise<Factory> {
  const teams = createTeamStore(db);
  if ((await teams.list(workspaceId)).length === 0) {
    await db.transaction((tx) => openWorkspace(tx, { workspaceId, ownerId: 'person-dana' }));
  }
  const [first] = await teams.list(workspaceId);
  if (!first) throw new Error(`${workspaceId} has no first team`);
  const made = await createFactoryStore(db).create(workspaceId, {
    name,
    teamId: first.id,
    personId: 'person-dana',
  });
  if (typeof made === 'string') throw new Error(`${name} was not made: ${made}`);
  return made;
}

const credentials = (factory: Factory, clientId = '1111.2222'): SlackCredentials => ({
  workspaceId: 'sprocket',
  factoryId: factory.id,
  clientId,
  clientSecret: sealed('client-secret'),
  signingSecret: sealed('signing-secret'),
  handle: 'code-review',
  configuredBy: 'person-dana',
  at: at('2026-11-27T10:00:00Z'),
});

const install = (appId = 'A0SPROCKET'): SlackInstall => ({
  appId,
  teamId: 'T0SPROCKET',
  teamName: 'Sprocket',
  botUserId: 'U0BOT',
  installedBy: 'person-dana',
  installedAt: at('2026-11-27T10:05:00Z'),
});

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  ({ apps, links, events, requests } = createSlackStores(db));
});

afterEach(async () => {
  await close();
});

describe("a factory's Slack app", () => {
  it('is none until its credentials are saved, then awaits its install', async () => {
    const factory = await factoryOf('sprocket', 'Code review');
    expect(await apps.get('sprocket', factory.id)).toBeNull();

    expect(await apps.saveCredentials(credentials(factory))).toBe('saved');
    const app = await apps.get('sprocket', factory.id);
    expect(app).toEqual({
      workspaceId: 'sprocket',
      factoryId: factory.id,
      clientId: '1111.2222',
      handle: 'code-review',
      configuredBy: 'person-dana',
      configuredAt: at('2026-11-27T10:00:00Z'),
      install: null,
      needsReinstall: false,
      sealed: {
        clientSecret: sealed('client-secret'),
        signingSecret: sealed('signing-secret'),
        botToken: null,
      },
    });
    expect(await apps.ofFactory(factory.id)).toEqual(app);
    expect(await apps.ofWorkspace('sprocket')).toEqual([app]);
  });

  it('is not saved for a factory another workspace holds, nor one that does not exist', async () => {
    const factory = await factoryOf('sprocket', 'Code review');
    await factoryOf('initech', 'Other');
    expect(await apps.saveCredentials({ ...credentials(factory), workspaceId: 'initech' })).toBe(
      'not-found',
    );
    expect(await apps.saveCredentials({ ...credentials(factory), factoryId: 'no-such' })).toBe(
      'not-found',
    );
    expect(await apps.get('sprocket', factory.id)).toBeNull();

    // Nor changed there once it exists.
    await apps.saveCredentials(credentials(factory));
    expect(
      await apps.saveCredentials({ ...credentials(factory, '9999.9999'), workspaceId: 'initech' }),
    ).toBe('not-found');
    expect((await apps.get('sprocket', factory.id))?.clientId).toBe('1111.2222');
    expect(await apps.get('initech', factory.id)).toBeNull();
  });

  it('records an install made with its client ID, and keeps it when the same app is saved again', async () => {
    const factory = await factoryOf('sprocket', 'Code review');
    await apps.saveCredentials(credentials(factory));
    expect(
      await apps.install({
        workspaceId: 'sprocket',
        factoryId: factory.id,
        clientId: '1111.2222',
        install: install(),
        botToken: sealed('xoxb'),
        handle: 'code-review-bot',
      }),
    ).toBe('installed');
    const installed = await apps.get('sprocket', factory.id);
    expect(installed?.install).toEqual(install());
    expect(installed?.handle).toBe('code-review-bot');
    expect(installed?.sealed.botToken).toBe(sealed('xoxb'));

    // A new signing secret for the same app: the install stays, with the handle Slack gave.
    await apps.saveCredentials({ ...credentials(factory), signingSecret: sealed('rotated') });
    const again = await apps.get('sprocket', factory.id);
    expect(again?.install).toEqual(install());
    expect(again?.handle).toBe('code-review-bot');
    expect(again?.sealed).toEqual({
      clientSecret: sealed('client-secret'),
      signingSecret: sealed('rotated'),
      botToken: sealed('xoxb'),
    });
  });

  it('forgets the install when another app’s credentials are saved', async () => {
    const factory = await factoryOf('sprocket', 'Code review');
    await apps.saveCredentials(credentials(factory));
    await apps.install({
      workspaceId: 'sprocket',
      factoryId: factory.id,
      clientId: '1111.2222',
      install: install(),
      botToken: sealed('xoxb'),
      handle: 'code-review-bot',
    });
    await apps.markNeedsReinstall({
      workspaceId: 'sprocket',
      factoryId: factory.id,
      appId: 'A0SPROCKET',
    });

    await apps.saveCredentials(credentials(factory, '3333.4444'));
    const app = await apps.get('sprocket', factory.id);
    expect(app?.clientId).toBe('3333.4444');
    expect(app?.install).toBeNull();
    expect(app?.needsReinstall).toBe(false);
    expect(app?.sealed.botToken).toBeNull();
    expect(app?.handle).toBe('code-review');
  });

  it('refuses an install made with a client ID it no longer has, or for no app', async () => {
    const factory = await factoryOf('sprocket', 'Code review');
    const entry = {
      workspaceId: 'sprocket',
      factoryId: factory.id,
      clientId: '1111.2222',
      install: install(),
      botToken: sealed('xoxb'),
      handle: 'code-review',
    };
    expect(await apps.install(entry)).toBe('not-found');
    await apps.saveCredentials(credentials(factory, '3333.4444'));
    expect(await apps.install(entry)).toBe('credentials-changed');
    expect((await apps.get('sprocket', factory.id))?.install).toBeNull();
  });

  it('holds one app id for one factory', async () => {
    const review = await factoryOf('sprocket', 'Code review');
    const triage = await factoryOf('sprocket', 'Triage');
    await apps.saveCredentials(credentials(review));
    await apps.saveCredentials(credentials(triage));
    const entry = (factory: Factory) => ({
      workspaceId: 'sprocket',
      factoryId: factory.id,
      clientId: '1111.2222',
      install: install(),
      botToken: sealed('xoxb'),
      handle: 'bot',
    });
    expect(await apps.install(entry(review))).toBe('installed');
    expect(await apps.install(entry(triage))).toBe('app-taken');
    expect((await apps.get('sprocket', triage.id))?.install).toBeNull();
    // Installing the same app on its own factory again is fine.
    expect(await apps.install(entry(review))).toBe('installed');
  });

  it('marks an install as needing a reinstall only for the app it names, and an install clears it', async () => {
    const factory = await factoryOf('sprocket', 'Code review');
    await apps.saveCredentials(credentials(factory));
    const ids = { workspaceId: 'sprocket', factoryId: factory.id, appId: 'A0SPROCKET' };
    expect(await apps.markNeedsReinstall(ids)).toBe(false);
    const entry = {
      workspaceId: 'sprocket',
      factoryId: factory.id,
      clientId: '1111.2222',
      install: install(),
      botToken: sealed('xoxb'),
      handle: 'bot',
    };
    await apps.install(entry);
    expect(await apps.markNeedsReinstall({ ...ids, appId: 'A0OTHER' })).toBe(false);
    expect(await apps.markNeedsReinstall({ ...ids, workspaceId: 'initech' })).toBe(false);
    expect(await apps.markNeedsReinstall(ids)).toBe(true);
    expect((await apps.get('sprocket', factory.id))?.needsReinstall).toBe(true);
    await apps.install(entry);
    expect((await apps.get('sprocket', factory.id))?.needsReinstall).toBe(false);
  });

  it('forgets the app, its events, its links and its threads, and nothing of another factory', async () => {
    const review = await factoryOf('sprocket', 'Code review');
    const triage = await factoryOf('sprocket', 'Triage');
    for (const factory of [review, triage]) {
      await apps.saveCredentials(credentials(factory));
      await events.record({
        workspaceId: 'sprocket',
        factoryId: factory.id,
        eventId: 'Ev01',
        at: at('2026-11-27T10:10:00Z'),
      });
      await links.createRequest(
        linkRequest({ factoryId: factory.id, tokenHash: `hash-${factory.id}` }),
      );
      await session(`session-${factory.id}`);
      await requests.record(thread({ factoryId: factory.id, sessionId: `session-${factory.id}` }));
    }
    await links.confirm({
      tokenHash: `hash-${review.id}`,
      personId: 'person-dana',
      at: at('2026-11-27T10:01:00Z'),
    });

    const forgotten = await apps.forget('sprocket', review.id);
    expect(forgotten?.factoryId).toBe(review.id);
    expect(await apps.get('sprocket', review.id)).toBeNull();
    expect(await links.findRequest(`hash-${review.id}`)).toBeNull();
    expect(await requests.ofSession(`session-${review.id}`)).toBeNull();
    expect(
      await events.record({
        workspaceId: 'sprocket',
        factoryId: review.id,
        eventId: 'Ev01',
        at: at('2026-11-27T10:20:00Z'),
      }),
    ).toBe('recorded');
    // The person's link is theirs, not the app's: it stays.
    expect(
      await links.personOf({
        workspaceId: 'sprocket',
        slackTeamId: 'T0SPROCKET',
        slackUserId: 'U0DANA',
      }),
    ).toBe('person-dana');

    // The other factory keeps all of its own.
    expect(await apps.get('sprocket', triage.id)).not.toBeNull();
    expect(await links.findRequest(`hash-${triage.id}`)).not.toBeNull();
    expect(await requests.ofSession(`session-${triage.id}`)).not.toBeNull();

    expect(await apps.forget('sprocket', review.id)).toBeNull();
    expect(await apps.forget('initech', triage.id)).toBeNull();
    expect(await apps.get('sprocket', triage.id)).not.toBeNull();
  });
});

const linkRequest = (overrides: Partial<SlackLinkRequest> = {}): SlackLinkRequest => ({
  tokenHash: 'hash-1',
  workspaceId: 'sprocket',
  factoryId: 'none',
  slackTeamId: 'T0SPROCKET',
  slackUserId: 'U0DANA',
  channelId: 'C0GENERAL',
  createdAt: at('2026-11-27T10:00:00Z'),
  expiresAt: at('2026-11-27T10:15:00Z'),
  usedAt: null,
  ...overrides,
});

/** A cloud session for a thread to point at: an agent run's, which no person started. */
async function session(id: string): Promise<void> {
  await createCloudSessionStore(db).insert({
    id,
    workspaceId: 'sprocket',
    personId: null,
    repository: 'sprocket/catalog-portal',
    harness: 'claude',
    status: 'starting',
    title: null,
    hostUrl: null,
    error: null,
    errorCode: null,
    runnerId: null,
    createdAt: 1_795_000_000,
    endedAt: null,
    origin: null,
    agentRun: null,
  });
}

const thread = (overrides: Partial<SlackRequestThread> = {}): SlackRequestThread => ({
  workspaceId: 'sprocket',
  sessionId: 'session-1',
  factoryId: 'none',
  slackTeamId: 'T0SPROCKET',
  channelId: 'C0GENERAL',
  threadTs: '1795000000.000100',
  messageTs: '1795000000.000100',
  startedBy: 'person-dana',
  posted: null,
  createdAt: at('2026-11-27T10:00:00Z'),
  ...overrides,
});

describe('the links', () => {
  let factory: Factory;
  beforeEach(async () => {
    factory = await factoryOf('sprocket', 'Code review');
    await links.createRequest(linkRequest({ factoryId: factory.id }));
  });

  it('keeps a link request by its hash', async () => {
    expect(await links.findRequest('hash-1')).toEqual(linkRequest({ factoryId: factory.id }));
    expect(await links.findRequest('hash-2')).toBeNull();
  });

  it("finds the newest link still open for a Slack user's factory and channel, and no other", async () => {
    const writer = {
      workspaceId: 'sprocket',
      factoryId: factory.id,
      slackTeamId: 'T0SPROCKET',
      slackUserId: 'U0DANA',
      channelId: 'C0GENERAL',
    };
    const newer = linkRequest({
      tokenHash: 'hash-2',
      factoryId: factory.id,
      createdAt: at('2026-11-27T10:05:00Z'),
      expiresAt: at('2026-11-27T10:20:00Z'),
    });
    await links.createRequest(newer);
    expect(await links.openRequestOf(writer, at('2026-11-27T10:06:00Z'))).toEqual(newer);
    // The first expires at 10:15, the newer at 10:20.
    expect(await links.openRequestOf(writer, at('2026-11-27T10:20:00Z'))).toBeNull();
    for (const other of [
      { slackUserId: 'U0FAY' },
      { channelId: 'C0PRICING' },
      { slackTeamId: 'T0GLOBEX' },
      { workspaceId: 'globex' },
      { factoryId: 'another' },
    ]) {
      expect(
        await links.openRequestOf({ ...writer, ...other }, at('2026-11-27T10:06:00Z')),
      ).toBeNull();
    }
    await links.confirm({
      tokenHash: 'hash-2',
      personId: 'person-dana',
      at: at('2026-11-27T10:07:00Z'),
    });
    // The newer is used: the first is still open, until 10:15.
    expect((await links.openRequestOf(writer, at('2026-11-27T10:08:00Z')))?.tokenHash).toBe(
      'hash-1',
    );
  });

  it('confirms an open link once, and links the Slack account to the person', async () => {
    const answer = await links.confirm({
      tokenHash: 'hash-1',
      personId: 'person-dana',
      at: at('2026-11-27T10:05:00Z'),
    });
    expect(answer).toEqual({
      kind: 'linked',
      link: {
        id: expect.any(String),
        workspaceId: 'sprocket',
        slackTeamId: 'T0SPROCKET',
        slackUserId: 'U0DANA',
        personId: 'person-dana',
        linkedAt: at('2026-11-27T10:05:00Z'),
      },
    });
    expect((await links.findRequest('hash-1'))?.usedAt).toEqual(at('2026-11-27T10:05:00Z'));
    expect(
      await links.confirm({
        tokenHash: 'hash-1',
        personId: 'person-dana',
        at: at('2026-11-27T10:06:00Z'),
      }),
    ).toEqual({ kind: 'used' });
    expect(
      await links.personOf({
        workspaceId: 'sprocket',
        slackTeamId: 'T0SPROCKET',
        slackUserId: 'U0DANA',
      }),
    ).toBe('person-dana');
    expect(
      await links.personOf({
        workspaceId: 'initech',
        slackTeamId: 'T0SPROCKET',
        slackUserId: 'U0DANA',
      }),
    ).toBeNull();
  });

  it('refuses a link that expired, or that it does not have', async () => {
    expect(
      await links.confirm({
        tokenHash: 'hash-1',
        personId: 'person-dana',
        at: at('2026-11-27T10:15:00Z'),
      }),
    ).toEqual({ kind: 'expired' });
    expect(
      await links.confirm({
        tokenHash: 'hash-9',
        personId: 'person-dana',
        at: at('2026-11-27T10:01:00Z'),
      }),
    ).toEqual({ kind: 'not-found' });
    expect(
      await links.personOf({
        workspaceId: 'sprocket',
        slackTeamId: 'T0SPROCKET',
        slackUserId: 'U0DANA',
      }),
    ).toBeNull();
  });

  it('never links one Slack account to two people in a workspace', async () => {
    await links.confirm({
      tokenHash: 'hash-1',
      personId: 'person-dana',
      at: at('2026-11-27T10:05:00Z'),
    });
    await links.createRequest(linkRequest({ factoryId: factory.id, tokenHash: 'hash-2' }));
    expect(
      await links.confirm({
        tokenHash: 'hash-2',
        personId: 'person-eli',
        at: at('2026-11-27T10:06:00Z'),
      }),
    ).toEqual({ kind: 'linked-to-another' });
    expect((await links.findRequest('hash-2'))?.usedAt).toBeNull();

    // The same person again is linked already, and the link is used.
    const again = await links.confirm({
      tokenHash: 'hash-2',
      personId: 'person-dana',
      at: at('2026-11-27T10:07:00Z'),
    });
    expect(again.kind).toBe('already-linked');
    expect((await links.findRequest('hash-2'))?.usedAt).toEqual(at('2026-11-27T10:07:00Z'));
  });

  it("lists a person's links in a workspace, and unlinks only their own", async () => {
    await links.confirm({
      tokenHash: 'hash-1',
      personId: 'person-dana',
      at: at('2026-11-27T10:05:00Z'),
    });
    await links.createRequest(
      linkRequest({
        factoryId: factory.id,
        tokenHash: 'hash-2',
        slackTeamId: 'T0OTHER',
        slackUserId: 'U0DANA2',
      }),
    );
    await links.confirm({
      tokenHash: 'hash-2',
      personId: 'person-dana',
      at: at('2026-11-27T10:06:00Z'),
    });
    const mine = await links.linksOf('sprocket', 'person-dana');
    expect(mine.map((link) => link.slackTeamId)).toEqual(['T0SPROCKET', 'T0OTHER']);
    expect(await links.linksOf('sprocket', 'person-eli')).toEqual([]);
    expect(await links.linksOf('initech', 'person-dana')).toEqual([]);

    const [first] = mine;
    if (!first) throw new Error('no link');
    expect(
      await links.unlink({ workspaceId: 'sprocket', personId: 'person-eli', linkId: first.id }),
    ).toBe(false);
    expect(
      await links.unlink({ workspaceId: 'initech', personId: 'person-dana', linkId: first.id }),
    ).toBe(false);
    expect(
      await links.unlink({ workspaceId: 'sprocket', personId: 'person-dana', linkId: first.id }),
    ).toBe(true);
    expect(
      (await links.linksOf('sprocket', 'person-dana')).map((link) => link.slackTeamId),
    ).toEqual(['T0OTHER']);
  });
});

describe('the events', () => {
  it('records an event once per factory', async () => {
    const review = await factoryOf('sprocket', 'Code review');
    const triage = await factoryOf('sprocket', 'Triage');
    const event = {
      workspaceId: 'sprocket',
      factoryId: review.id,
      eventId: 'Ev01',
      at: at('2026-11-27T10:00:00Z'),
    };
    expect(await events.record(event)).toBe('recorded');
    expect(await events.record(event)).toBe('recorded-before');
    expect(await events.record({ ...event, factoryId: triage.id })).toBe('recorded');
  });
});

describe('the threads', () => {
  it("records a request's thread, finds it by session and by thread, and posts each state once", async () => {
    const factory = await factoryOf('sprocket', 'Code review');
    await session('session-1');
    await session('session-2');
    await requests.record(thread({ factoryId: factory.id }));
    await requests.record(
      thread({
        factoryId: factory.id,
        sessionId: 'session-2',
        createdAt: at('2026-11-27T11:00:00Z'),
      }),
    );
    expect(await requests.ofSession('session-1')).toEqual(thread({ factoryId: factory.id }));
    expect(await requests.ofSession('session-9')).toBeNull();
    const inThread = await requests.inThread({
      factoryId: factory.id,
      channelId: 'C0GENERAL',
      threadTs: '1795000000.000100',
    });
    expect(inThread.map((each) => each.sessionId)).toEqual(['session-1', 'session-2']);
    expect(
      await requests.inThread({
        factoryId: factory.id,
        channelId: 'C0OTHER',
        threadTs: '1795000000.000100',
      }),
    ).toEqual([]);

    expect(await requests.markPosted('session-1', null, 'waiting')).toBe(true);
    expect(await requests.markPosted('session-1', null, 'waiting')).toBe(false);
    expect(await requests.markPosted('session-1', 'waiting', 'done')).toBe(true);
    expect(await requests.markPosted('session-1', 'waiting', 'stopped')).toBe(false);
    expect((await requests.ofSession('session-1'))?.posted).toBe('done');
  });

  it('refuses a thread whose session is not recorded', async () => {
    const factory = await factoryOf('sprocket', 'Code review');
    await expect(
      requests.record(thread({ factoryId: factory.id, sessionId: 'nobody' })),
    ).rejects.toThrow();
  });
});
