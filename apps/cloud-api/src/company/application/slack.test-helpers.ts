// What the tests of Slack's requests share: a stand-in for Slack's Web API that records each call,
// a sealer that marks what it seals, and a factory of Sprocket's with its app added to Slack, on
// the real stores. For tests only: the build leaves it out.

import type { Database } from '../adapters/persistence/database.js';
import { makeTestWorkspace } from '../adapters/persistence/database.test-helpers.js';
import { createSlackStores } from '../adapters/persistence/slackStores.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import type { Factory, FactoryFile } from '../domain/factory.js';
import type { Sealed } from '../domain/slack.js';
import { isInstalled } from '../domain/slackEvents.js';
import type { InstalledSlackApp } from '../domain/slackEvents.js';
import type { FakeMembership } from './membership.test-helpers.js';
import type { LinkTokens, SecretSealer, SlackAnswer, SlackApi } from './slackPorts.js';

/** Seals by marking, so a test can see what was sealed; opens only what it marked. */
export const markingSealer: SecretSealer = {
  seal: (secret) => `sealed:${secret}` as Sealed,
  open: (sealed) => (sealed.startsWith('sealed:') ? sealed.slice('sealed:'.length) : null),
};

/** Tokens numbered as they are made, each kept as `hash:<token>`. */
export function countingTokens(): LinkTokens {
  let made = 0;
  return {
    newToken: () => `token-${++made}`,
    hashOf: (token) => `hash:${token}`,
  };
}

/** One call made to the stand-in Slack: its method, the token it carried, and what it asked. */
export type SlackCall = { method: string; token: string; args: Record<string, unknown> };

/** The Slack methods the stand-in answers. */
type Method = 'chat.postMessage' | 'chat.postEphemeral' | 'reactions.add' | 'chat.getPermalink';

/**
 * A stand-in for Slack's Web API that records each call, in order, and answers as Slack does,
 * unless told to refuse a method with a code (`refuse`) or not to answer it (`fail`).
 */
export function fakeSlackApi() {
  const calls: SlackCall[] = [];
  const refusals = new Map<Method, string>();
  const failures = new Set<Method>();
  let posted = 0;

  function answer<T>(
    method: Method,
    token: string,
    args: Record<string, unknown>,
    value: T,
  ): SlackAnswer<T> {
    calls.push({ method, token, args });
    const code = refusals.get(method);
    if (code !== undefined) return { ok: false, error: { kind: 'refused', code } };
    if (failures.has(method)) {
      return { ok: false, error: { kind: 'unavailable', reason: 'Slack did not answer in time' } };
    }
    return { ok: true, value };
  }

  const unused = async (): Promise<never> => {
    throw new Error('Not a method requests use.');
  };

  const api: SlackApi = {
    oauthAccess: unused,
    authRevoke: unused,
    authTest: unused,
    postMessage: async (token, message) =>
      answer(
        'chat.postMessage',
        token,
        { ...message },
        {
          channel: message.channel,
          ts: `1795000100.${String(++posted).padStart(6, '0')}`,
        },
      ),
    postEphemeral: async (token, message) =>
      answer('chat.postEphemeral', token, { ...message }, { messageTs: '1795000100.000000' }),
    addReaction: async (token, reaction) => answer('reactions.add', token, { ...reaction }, null),
    getPermalink: async (token, message) =>
      answer(
        'chat.getPermalink',
        token,
        { ...message },
        {
          permalink: `https://sprocket.slack.com/archives/${message.channel}/p${message.messageTs.replace('.', '')}`,
        },
      ),
  };

  return {
    api,
    calls,
    /** Slack refuses `method` from now on, with `code`. */
    refuse(method: Method, code: string) {
      refusals.set(method, code);
    },
    /** Slack does not answer `method` from now on. */
    fail(method: Method) {
      failures.add(method);
    },
    /** The calls of one method, in order. */
    of(method: Method) {
      return calls.filter((call) => call.method === method);
    },
  };
}

export type FakeSlack = ReturnType<typeof fakeSlackApi>;

/** The Slack ids the tests use: Sprocket's Slack workspace, its factory's app and its bot. */
export const SPROCKET_SLACK = {
  teamId: 'T0SPROCKET',
  appId: 'A0SPROCKET',
  botUserId: 'U0BOT',
  botToken: 'xoxb-sprocket',
} as const;

/**
 * Sprocket, made whole with Dana (owner) and Fay (member) in its first team, and a second team,
 * Pricing, with Dana alone. Its factory `Code review` is on the first team, with `files` as its
 * latest version; `Price lists` is on Pricing, which Fay does not see.
 */
export async function holdSprocket(
  db: Database,
  membership: FakeMembership,
  files: readonly FactoryFile[] = [],
): Promise<{ factory: Factory; hidden: Factory }> {
  await makeTestWorkspace(db, membership, 'sprocket', [
    ['person-dana', 'owner'],
    ['person-fay', 'member'],
  ]);
  const { teams, factories } = createDrizzleStores(db);
  const [first] = await teams.list('sprocket');
  const pricing = await teams.create('sprocket', 'Pricing');
  if (!first || typeof pricing === 'string') throw new Error('Sprocket has no teams');
  const make = async (name: string, teamId: string) => {
    const made = await factories.create('sprocket', { name, teamId, personId: 'person-dana' });
    if (typeof made === 'string') throw new Error(made);
    if (files.length === 0) return made;
    const saved = await factories.save('sprocket', made.id, {
      baseVersion: 1,
      files,
      personId: 'person-dana',
    });
    if (saved.kind !== 'saved') throw new Error(saved.kind);
    return { ...made, latestVersion: saved.version.version };
  };
  return {
    factory: await make('Code review', first.id),
    hidden: await make('Price lists', pricing.id),
  };
}

/** The factory's app, its credentials saved and added to Sprocket's Slack as `appId`. */
export async function installSlackApp(
  db: Database,
  factory: Factory,
  appId: string = SPROCKET_SLACK.appId,
): Promise<InstalledSlackApp> {
  const { apps } = createSlackStores(db);
  await apps.saveCredentials({
    workspaceId: 'sprocket',
    factoryId: factory.id,
    clientId: '1111.2222',
    clientSecret: markingSealer.seal('client-secret'),
    signingSecret: markingSealer.seal('sprocketsigningsecret0123456789ab'),
    handle: 'code-review',
    configuredBy: 'person-dana',
    at: new Date('2026-11-27T10:00:00Z'),
  });
  const installed = await apps.install({
    workspaceId: 'sprocket',
    factoryId: factory.id,
    clientId: '1111.2222',
    install: {
      appId,
      teamId: SPROCKET_SLACK.teamId,
      teamName: 'Sprocket',
      botUserId: SPROCKET_SLACK.botUserId,
      installedBy: 'person-dana',
      installedAt: new Date('2026-11-27T10:05:00Z'),
    },
    botToken: markingSealer.seal(SPROCKET_SLACK.botToken),
    handle: 'code-review',
  });
  if (installed !== 'installed') throw new Error(installed);
  const app = await apps.get('sprocket', factory.id);
  if (app === null || !isInstalled(app)) throw new Error('The app is not installed');
  return app;
}

/** Links the Slack user to the person in Sprocket, as confirming a one-time link does. */
export async function linkSlackUser(db: Database, slackUserId: string, personId: string) {
  const { links } = createSlackStores(db);
  const tokenHash = `hash:link-of-${slackUserId}`;
  await links.createRequest({
    tokenHash,
    workspaceId: 'sprocket',
    factoryId: (await createDrizzleStores(db).factories.list('sprocket'))[0]?.id ?? '',
    slackTeamId: SPROCKET_SLACK.teamId,
    slackUserId,
    channelId: 'C0CATALOG',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
  });
  const confirmed = await links.confirm({ tokenHash, personId, at: new Date() });
  if (confirmed.kind !== 'linked') throw new Error(confirmed.kind);
}
