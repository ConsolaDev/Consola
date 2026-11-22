import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceStore } from '../../application/ports.js';
import { type Database, migrateDatabase, openDatabase } from './database.js';
import { schema } from './schema.js';
import { createWorkspaceStore } from './workspaceStore.js';

let db: Database;
let close: () => Promise<void>;
let workspaces: WorkspaceStore;
let wakes: number;

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db.insert(schema.user).values([
    { id: 'dana', name: 'Dana', email: 'dana@acme.test', emailVerified: true },
    { id: 'lee', name: 'Lee', email: 'lee@sprocket.test', emailVerified: true },
  ]);
  wakes = 0;
  workspaces = createWorkspaceStore(db, { messageWritten: () => (wakes += 1) });
});

/** The outbox as stored, in the order its cell hears it. */
const outbox = () =>
  db
    .select({
      workspaceId: schema.outboxMessage.organizationId,
      sequence: schema.outboxMessage.sequence,
      region: schema.outboxMessage.region,
      changeType: schema.outboxMessage.changeType,
      personId: schema.outboxMessage.personId,
      role: schema.outboxMessage.role,
    })
    .from(schema.outboxMessage)
    .orderBy(asc(schema.outboxMessage.organizationId), asc(schema.outboxMessage.sequence));

afterEach(async () => {
  await close();
});

const acme = { name: 'Acme', slug: 'acme', region: 'eu' as const };
const dana = { userId: 'dana', role: 'owner' as const };

describe('the workspace store', () => {
  it('makes the workspace in the region asked for, with its first member', async () => {
    const made = await workspaces.create({ ...acme, region: 'us' }, dana);
    expect(made).toEqual({
      kind: 'created',
      workspace: { id: expect.any(String), name: 'Acme', slug: 'acme', region: 'us' },
    });
    if (made.kind !== 'created') throw new Error('not created');

    expect(await db.select().from(schema.organization)).toEqual([
      expect.objectContaining({ id: made.workspace.id, slug: 'acme', region: 'us' }),
    ]);
    expect(await db.select().from(schema.member)).toEqual([
      expect.objectContaining({ organizationId: made.workspace.id, userId: 'dana', role: 'owner' }),
    ]);
  });

  it("writes the cell's messages with them: the workspace at 1, its owner at 2", async () => {
    const made = await workspaces.create(acme, dana);
    if (made.kind !== 'created') throw new Error('not created');
    const id = made.workspace.id;

    expect(await outbox()).toEqual([
      {
        workspaceId: id,
        sequence: 1,
        region: 'eu',
        changeType: 'workspace.created',
        personId: null,
        role: null,
      },
      {
        workspaceId: id,
        sequence: 2,
        region: 'eu',
        changeType: 'member.added',
        personId: 'dana',
        role: 'owner',
      },
    ]);
    expect(wakes).toBe(1);
  });

  it('refuses a slug that is taken, in any region, and writes nothing', async () => {
    await workspaces.create(acme, dana);
    expect(
      await workspaces.create(
        { name: 'Acme US', slug: 'acme', region: 'us' },
        { userId: 'lee', role: 'owner' },
      ),
    ).toEqual({ kind: 'slug-taken' });

    expect(await db.select().from(schema.organization)).toHaveLength(1);
    expect(await db.select().from(schema.member).where(eq(schema.member.userId, 'lee'))).toEqual(
      [],
    );
    expect(await outbox()).toHaveLength(2);
    expect(wakes).toBe(1);
  });

  it('writes no workspace, and no message, when its first member cannot be written', async () => {
    await expect(workspaces.create(acme, { userId: 'nobody', role: 'owner' })).rejects.toThrow();
    expect(await db.select().from(schema.organization)).toEqual([]);
    expect(await outbox()).toEqual([]);
    expect(wakes).toBe(0);
  });

  it('gives each workspace an id of its own', async () => {
    const first = await workspaces.create(acme, dana);
    const second = await workspaces.create({ ...acme, slug: 'acme-2' }, dana);
    if (first.kind !== 'created' || second.kind !== 'created') throw new Error('not created');
    expect(first.workspace.id).not.toBe(second.workspace.id);
  });
});
