import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OutboxStore } from '../../application/ports.js';
import { migrateDatabase, openDatabase } from './database.js';
import type { Database } from './database.js';
import { createOutboxStore } from './outboxStore.js';
import { schema } from './schema.js';
import { createWorkspaceStore } from './workspaceStore.js';
import { writeWorkspaceChange } from './workspaceChanges.js';

let db: Database;
let close: () => Promise<void>;
let outbox: OutboxStore;

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db.insert(schema.user).values([
    { id: 'person-dana', name: 'Dana Ortiz', email: 'dana@acme.test', emailVerified: true },
    { id: 'person-lee', name: 'Lee Park', email: 'lee@sprocket.test', emailVerified: true },
  ]);
  outbox = createOutboxStore(db);
});

afterEach(async () => {
  await close();
});

async function make(slug: string, region: 'eu' | 'us', owner: string): Promise<string> {
  const made = await createWorkspaceStore(db).create(
    { name: slug, slug, region },
    { userId: owner, role: 'owner' },
  );
  if (made.kind !== 'created') throw new Error('not created');
  return made.workspace.id;
}

const rowOf = async (workspaceId: string, sequence: number) => {
  const [row] = await db
    .select()
    .from(schema.outboxMessage)
    .where(
      and(
        eq(schema.outboxMessage.organizationId, workspaceId),
        eq(schema.outboxMessage.sequence, sequence),
      ),
    );
  return row;
};

describe('the outbox store', () => {
  it("hands each workspace's first undelivered message, in the contract's shape", async () => {
    const acme = await make('acme', 'eu', 'person-dana');
    const sprocket = await make('sprocket', 'us', 'person-lee');

    const created = (workspaceId: string, region: string) => ({
      key: { workspaceId, sequence: 1 },
      stored: { workspaceId, region, sequence: 1, change: { type: 'workspace.created' } },
      attempts: 0,
      nextAttemptAt: null,
    });
    const first = await outbox.firstUndelivered();
    expect(first).toHaveLength(2);
    expect(first).toEqual(expect.arrayContaining([created(acme, 'eu'), created(sprocket, 'us')]));
  });

  it('moves on to the next message once one is delivered, and records when', async () => {
    const acme = await make('acme', 'eu', 'person-dana');
    const at = new Date('2026-11-22T10:00:00Z');

    await outbox.recordDelivered({ workspaceId: acme, sequence: 1 }, at);

    expect(await outbox.firstUndeliveredOf(acme)).toEqual({
      key: { workspaceId: acme, sequence: 2 },
      stored: {
        workspaceId: acme,
        region: 'eu',
        sequence: 2,
        change: { type: 'member.added', personId: 'person-dana', role: 'owner' },
      },
      attempts: 0,
      nextAttemptAt: null,
    });
    expect(await rowOf(acme, 1)).toMatchObject({ deliveredAt: at, lastAttemptAt: at, attempts: 1 });

    await outbox.recordDelivered({ workspaceId: acme, sequence: 2 }, at);
    expect(await outbox.firstUndeliveredOf(acme)).toBeNull();
    expect(await outbox.firstUndelivered()).toEqual([]);
  });

  it('records a failure, its reason and when the next try is due, and keeps the message', async () => {
    const acme = await make('acme', 'eu', 'person-dana');
    const at = new Date('2026-11-22T10:00:00Z');
    const nextAttemptAt = new Date('2026-11-22T10:00:01Z');

    await outbox.recordFailed(
      { workspaceId: acme, sequence: 1 },
      { at, error: 'status 503 (unavailable)', nextAttemptAt },
    );
    await outbox.recordFailed(
      { workspaceId: acme, sequence: 1 },
      {
        at: nextAttemptAt,
        error: 'no connection (ECONNREFUSED)',
        nextAttemptAt: new Date('2026-11-22T10:00:03Z'),
      },
    );

    expect(await outbox.firstUndeliveredOf(acme)).toMatchObject({
      key: { workspaceId: acme, sequence: 1 },
      attempts: 2,
      nextAttemptAt: new Date('2026-11-22T10:00:03Z'),
    });
    expect(await rowOf(acme, 1)).toMatchObject({
      attempts: 2,
      lastAttemptAt: nextAttemptAt,
      lastError: 'no connection (ECONNREFUSED)',
      deliveredAt: null,
    });

    // Delivered at last: the failure before it is kept, beside when it went.
    const deliveredAt = new Date('2026-11-22T10:00:04Z');
    await outbox.recordDelivered({ workspaceId: acme, sequence: 1 }, deliveredAt);
    expect(await rowOf(acme, 1)).toMatchObject({
      attempts: 3,
      deliveredAt,
      lastError: 'no connection (ECONNREFUSED)',
      nextAttemptAt: null,
    });
  });

  it('records nothing over a message already delivered', async () => {
    const acme = await make('acme', 'eu', 'person-dana');
    const deliveredAt = new Date('2026-11-22T10:00:00Z');
    await outbox.recordDelivered({ workspaceId: acme, sequence: 1 }, deliveredAt);

    await outbox.recordFailed(
      { workspaceId: acme, sequence: 1 },
      { at: new Date(), error: 'status 500', nextAttemptAt: new Date() },
    );
    await outbox.recordDelivered({ workspaceId: acme, sequence: 1 }, new Date());

    expect(await rowOf(acme, 1)).toMatchObject({ attempts: 1, deliveredAt, lastError: null });
  });

  it('hands a removal and a role change in their own shapes', async () => {
    const acme = await make('acme', 'eu', 'person-dana');
    await db.transaction(async (tx) => {
      await writeWorkspaceChange(tx, {
        workspaceId: acme,
        change: { type: 'member.added', personId: 'person-lee', role: 'member' },
      });
      await writeWorkspaceChange(tx, {
        workspaceId: acme,
        change: { type: 'member.role-changed', personId: 'person-lee', role: 'admin' },
      });
      await writeWorkspaceChange(tx, {
        workspaceId: acme,
        change: { type: 'member.removed', personId: 'person-lee' },
      });
    });
    for (const sequence of [1, 2, 3]) {
      await outbox.recordDelivered({ workspaceId: acme, sequence }, new Date());
    }

    expect((await outbox.firstUndeliveredOf(acme))?.stored).toEqual({
      workspaceId: acme,
      region: 'eu',
      sequence: 4,
      change: { type: 'member.role-changed', personId: 'person-lee', role: 'admin' },
    });
    await outbox.recordDelivered({ workspaceId: acme, sequence: 4 }, new Date());
    expect((await outbox.firstUndeliveredOf(acme))?.stored).toEqual({
      workspaceId: acme,
      region: 'eu',
      sequence: 5,
      change: { type: 'member.removed', personId: 'person-lee' },
    });
  });

  it('knows no workspace that has no messages', async () => {
    expect(await outbox.firstUndeliveredOf(randomUUID())).toBeNull();
  });
});
