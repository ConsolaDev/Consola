import type { GitHubEventMessage } from '@consola/cloud-contract';
import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import type { Database } from '../adapters/persistence/database.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import { gitHubEvents } from '../adapters/persistence/tables.js';
import type {
  DeliveryCheck,
  DeliveryVerifier,
  GitHubEventStore,
  RunnerChannel,
  WorkspaceCopies,
} from './ports.js';
import { receiveGitHubEvent } from './receiveGitHubEvent.js';

let db: Database;
let close: () => Promise<void>;
let workspaceCopies: WorkspaceCopies;
let events: GitHubEventStore;

beforeEach(async () => {
  const opened = openDatabase('pglite:memory');
  db = opened.db;
  let closed = false;
  close = async () => {
    if (closed) return;
    closed = true;
    await opened.close();
  };
  await migrateDatabase(db);
  ({ workspaceCopies, gitHubEvents: events } = createDrizzleStores(db));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

/** A verifier that takes every delivery as signed, its body being its payload. */
const signedAsSent: DeliveryVerifier = {
  async verify(delivery) {
    return { kind: 'verified', payload: new TextEncoder().encode(delivery) };
  },
};

const answering = (check: DeliveryCheck): DeliveryVerifier => ({ verify: async () => check });

const HEAD = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';

/** Acme (EU) opening a pull request in the `sprocket` organisation's repository. */
const opened = (overrides: Partial<GitHubEventMessage> = {}): GitHubEventMessage => ({
  workspaceId: 'acme',
  region: 'eu',
  deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
  event: 'pull_request',
  installationId: 41,
  payload: {
    action: 'opened',
    number: 7,
    pull_request: {
      number: 7,
      html_url: 'https://github.com/sprocket/catalog-portal/pull/7',
      title: 'Price the catalog in euros',
      user: { login: 'dana-sprocket' },
      draft: false,
      head: { sha: HEAD, ref: 'euro-prices', repo: { id: 410 } },
      base: { ref: 'main', repo: { id: 410 } },
    },
    repository: { id: 410, full_name: 'sprocket/catalog-portal' },
    installation: { id: 41 },
  },
  ...overrides,
});

/** The facts a runner is handed of `opened()`. */
const FACTS = {
  name: 'pull_request',
  action: 'opened',
  repository: 'sprocket/catalog-portal',
  number: 7,
  url: 'https://github.com/sprocket/catalog-portal/pull/7',
  title: 'Price the catalog in euros',
  author: 'dana-sprocket',
  draft: false,
  headSha: HEAD,
  headRef: 'euro-prices',
  baseRef: 'main',
  fork: false,
} as const;

/** The workspace's runner, as the use case reaches it: what it was handed, and whether it took it. */
let handed: Array<{ workspaceId: string; deliveryId: string }> = [];
let runnerTakes = true;
const runners: Pick<RunnerChannel, 'handEvent'> = {
  handEvent: (workspaceId, event) => {
    if (runnerTakes) handed.push({ workspaceId, deliveryId: event.deliveryId });
    return runnerTakes;
  },
};

beforeEach(() => {
  handed = [];
  runnerTakes = true;
});

/** The cell holds Acme: its `workspace.created` is applied. */
async function holdAcme() {
  expect(
    await workspaceCopies.applyAfter({
      workspaceId: 'acme',
      sequence: 1,
      after: null,
      change: { kind: 'open-workspace' },
    }),
  ).toBe('applied');
}

/** Delivers `value` as JSON to the eu cell, signed as sent. */
const deliver = (value: unknown, verifier: DeliveryVerifier = signedAsSent) =>
  receiveGitHubEvent(
    { events: verifier, gitHubEvents: events, runners },
    'eu',
    JSON.stringify(value),
  );

const recorded = () =>
  db
    .select()
    .from(gitHubEvents)
    .orderBy(asc(gitHubEvents.workspaceId), asc(gitHubEvents.deliveryId));

describe('receiveGitHubEvent', () => {
  it('records an event for a workspace the cell holds, its payload as GitHub sent it', async () => {
    await holdAcme();
    const event = opened();
    expect(await deliver(event)).toEqual({
      kind: 'recorded',
      event,
      now: true,
      runner: { kind: 'handed' },
    });

    const rows = await recorded();
    expect(rows).toEqual([
      {
        workspaceId: 'acme',
        deliveryId: event.deliveryId,
        event: 'pull_request',
        installationId: 41,
        payload: JSON.stringify(event.payload),
        receivedAt: expect.any(Date),
        repositoryId: 410,
        repository: 'sprocket/catalog-portal',
        runnerState: 'held',
        runnerFacts: FACTS,
      },
    ]);
  });

  it("hands a pull request's event to the workspace's runner, as its facts, held until it acknowledges", async () => {
    await holdAcme();
    await deliver(opened());
    expect(handed).toEqual([{ workspaceId: 'acme', deliveryId: opened().deliveryId }]);
    // Handed, and still held until the runner says it dealt with it.
    expect((await events.held('acme', 0, 10)).events).toEqual([
      { deliveryId: opened().deliveryId, facts: FACTS },
    ]);
  });

  it('records a delivery once, however often it arrives, and hands it once', async () => {
    await holdAcme();
    expect(await deliver(opened())).toMatchObject({ kind: 'recorded', now: true });
    const again = await deliver(
      opened({ payload: { action: 'closed', installation: { id: 41 } } }),
    );
    expect(again).toEqual({
      kind: 'recorded',
      event: expect.anything(),
      now: false,
      runner: null,
    });

    const rows = await recorded();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload ?? '')).toMatchObject({ action: 'opened' });
    expect(handed).toHaveLength(1);
  });

  it('holds an event no runner takes now, for its next hello', async () => {
    await holdAcme();
    runnerTakes = false;
    expect(await deliver(opened())).toMatchObject({ runner: { kind: 'held' } });
    expect((await events.held('acme', 0, 10)).events).toHaveLength(1);
  });

  it('records a pull request event that does not read into facts as not for runners, never handed', async () => {
    await holdAcme();
    const broken = opened({
      payload: { action: 'opened', pull_request: { number: 7 }, installation: { id: 41 } },
    });
    expect(await deliver(broken)).toEqual({
      kind: 'recorded',
      event: broken,
      now: true,
      runner: { kind: 'not-for-runners', reason: '`repository` does not name a repository' },
    });
    expect(handed).toEqual([]);
    expect((await recorded())[0]).toMatchObject({
      runnerState: 'not-for-runners',
      runnerFacts: null,
    });
    expect((await events.held('acme', 0, 10)).events).toEqual([]);
  });

  it('hands no other event to the runner, but keeps where it happened', async () => {
    await holdAcme();
    const push = opened({
      event: 'push',
      payload: {
        ref: 'refs/heads/main',
        repository: { id: 410, full_name: 'sprocket/catalog-portal' },
        installation: { id: 41 },
      },
    });
    expect(await deliver(push)).toEqual({ kind: 'recorded', event: push, now: true, runner: null });
    expect(handed).toEqual([]);
    expect((await recorded())[0]).toMatchObject({
      repositoryId: 410,
      repository: 'sprocket/catalog-portal',
      runnerState: null,
      runnerFacts: null,
    });
  });

  it('keeps a payload whatever it holds, a NUL character included', async () => {
    await holdAcme();
    const payload = { action: 'edited', body: 'before\u0000after', installation: { id: 41 } };
    expect(await deliver(opened({ payload }))).toMatchObject({ kind: 'recorded', now: true });
    expect(JSON.parse((await recorded())[0]?.payload ?? '')).toEqual(payload);
  });

  it('refuses what the signature check refuses, recording nothing', async () => {
    await holdAcme();
    const record = vi.spyOn(events, 'record');
    for (const check of [
      { kind: 'unsigned', reason: 'its typ is not consola-github-event' },
      { kind: 'keys-unavailable' },
    ] as const) {
      expect(await deliver(opened(), answering(check))).toEqual(check);
    }
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses a signed payload that is no event, with the reason', async () => {
    await holdAcme();
    const bytes = (payload: number[]): DeliveryVerifier =>
      answering({ kind: 'verified', payload: new Uint8Array(payload) });
    expect(await deliver(opened(), bytes([0xff]))).toEqual({
      kind: 'unreadable',
      reason: 'the payload is not UTF-8',
    });
    expect(await deliver(opened(), bytes([0x7b]))).toEqual({
      kind: 'unreadable',
      reason: 'the payload is not JSON',
    });
    expect(await deliver({ ...opened(), sentAt: 'now' })).toEqual({
      kind: 'unreadable',
      reason: 'the message has `sentAt`, which the contract does not name',
    });
    expect(await recorded()).toEqual([]);
  });

  it("refuses an event for another region's workspace", async () => {
    const event = opened({ workspaceId: 'sprocket', region: 'us' });
    expect(await deliver(event)).toEqual({ kind: 'other-region', event });
    expect(await recorded()).toEqual([]);
  });

  it('refuses an event for a workspace it holds nothing of yet', async () => {
    const event = opened();
    expect(await deliver(event)).toEqual({ kind: 'workspace-pending', event });
    expect(await recorded()).toEqual([]);
  });

  it('says the database did not answer, rather than throwing', async () => {
    await holdAcme();
    await close();
    const answer = await deliver(opened());
    expect(answer).toMatchObject({ kind: 'database-unavailable', event: opened() });
  });
});
