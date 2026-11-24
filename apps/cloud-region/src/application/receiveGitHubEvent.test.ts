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
    pull_request: { title: 'Price the catalog in euros' },
    repository: { full_name: 'sprocket/catalog-portal' },
    installation: { id: 41 },
  },
  ...overrides,
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
  receiveGitHubEvent({ events: verifier, gitHubEvents: events }, 'eu', JSON.stringify(value));

const recorded = () =>
  db
    .select()
    .from(gitHubEvents)
    .orderBy(asc(gitHubEvents.workspaceId), asc(gitHubEvents.deliveryId));

describe('receiveGitHubEvent', () => {
  it('records an event for a workspace the cell holds, its payload as GitHub sent it', async () => {
    await holdAcme();
    const event = opened();
    expect(await deliver(event)).toEqual({ kind: 'recorded', event, now: true });

    const rows = await recorded();
    expect(rows).toEqual([
      {
        workspaceId: 'acme',
        deliveryId: event.deliveryId,
        event: 'pull_request',
        installationId: 41,
        payload: JSON.stringify(event.payload),
        receivedAt: expect.any(Date),
      },
    ]);
  });

  it('records a delivery once, however often it arrives', async () => {
    await holdAcme();
    expect(await deliver(opened())).toMatchObject({ kind: 'recorded', now: true });
    const again = await deliver(
      opened({ payload: { action: 'closed', installation: { id: 41 } } }),
    );
    expect(again).toMatchObject({ kind: 'recorded', now: false });

    const rows = await recorded();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload ?? '')).toMatchObject({ action: 'opened' });
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
