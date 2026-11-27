import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceStore } from '../../application/ports.js';
import type { Database, Transaction } from './database.js';
import { schema } from './schema.js';
import { openTestDatabase } from './database.test-helpers.js';
import { createWorkspaceStore } from './workspaceStore.js';
import type { OpenedWorkspace } from './workspaceStore.js';

let db: Database;
let close: () => Promise<void>;
let workspaces: WorkspaceStore;

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  await db.insert(schema.user).values([
    { id: 'dana', name: 'Dana', email: 'dana@acme.test', emailVerified: true },
    { id: 'lee', name: 'Lee', email: 'lee@sprocket.test', emailVerified: true },
  ]);
  workspaces = createWorkspaceStore(db);
});

afterEach(async () => {
  await close();
});

const acme = { name: 'Acme', slug: 'acme', region: 'eu' as const };
const dana = { userId: 'dana', role: 'owner' as const };

/** A row only a hook writes, in a table of accounts', to see whether its writes commit. */
const hookRow = (on: Transaction, workspaceId: string) =>
  on.insert(schema.verification).values({
    id: `opened-${workspaceId}`,
    identifier: workspaceId,
    value: 'opened',
    expiresAt: new Date('2027-01-01'),
  });

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

  it('refuses a slug that is taken, and writes nothing', async () => {
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
  });

  it('writes no workspace when its first member cannot be written', async () => {
    await expect(workspaces.create(acme, { userId: 'nobody', role: 'owner' })).rejects.toThrow();
    expect(await db.select().from(schema.organization)).toEqual([]);
    expect(await db.select().from(schema.member)).toEqual([]);
  });

  it('gives each workspace an id of its own', async () => {
    const first = await workspaces.create(acme, dana);
    const second = await workspaces.create({ ...acme, slug: 'acme-2' }, dana);
    if (first.kind !== 'created' || second.kind !== 'created') throw new Error('not created');
    expect(first.workspace.id).not.toBe(second.workspace.id);
  });
});

describe("the workspace store's onCreated", () => {
  it('is handed the new ids, inside the transaction that holds both rows', async () => {
    const heard: Array<{ opened: OpenedWorkspace; organizations: number; members: unknown[] }> = [];
    const store = createWorkspaceStore(db, {
      onCreated: async (tx, opened) => {
        // Uncommitted, the rows are seen only through the transaction the hook is handed.
        const organizations = await tx
          .select()
          .from(schema.organization)
          .where(eq(schema.organization.id, opened.workspaceId));
        const members = await tx
          .select({ userId: schema.member.userId, role: schema.member.role })
          .from(schema.member)
          .where(eq(schema.member.organizationId, opened.workspaceId));
        heard.push({ opened, organizations: organizations.length, members });
      },
    });

    const made = await store.create(acme, dana);
    if (made.kind !== 'created') throw new Error('not created');
    expect(heard).toEqual([
      {
        opened: { workspaceId: made.workspace.id, ownerId: 'dana' },
        organizations: 1,
        members: [{ userId: 'dana', role: 'owner' }],
      },
    ]);
  });

  it('commits what it writes with the workspace', async () => {
    const store = createWorkspaceStore(db, {
      onCreated: async (tx, { workspaceId }) => {
        await hookRow(tx, workspaceId);
      },
    });
    const made = await store.create(acme, dana);
    if (made.kind !== 'created') throw new Error('not created');
    expect(
      await db.select({ identifier: schema.verification.identifier }).from(schema.verification),
    ).toEqual([{ identifier: made.workspace.id }]);
  });

  it('that throws leaves no organization, no member and nothing it wrote, and rejects', async () => {
    const store = createWorkspaceStore(db, {
      onCreated: async (tx, { workspaceId }) => {
        await hookRow(tx, workspaceId);
        throw new Error('the first team could not be made');
      },
    });

    await expect(store.create(acme, dana)).rejects.toThrow('the first team could not be made');
    expect(await db.select().from(schema.organization)).toEqual([]);
    expect(await db.select().from(schema.member)).toEqual([]);
    expect(await db.select().from(schema.verification)).toEqual([]);
  });

  it('is not called for a slug that is taken', async () => {
    await workspaces.create(acme, dana);
    const heard: OpenedWorkspace[] = [];
    const store = createWorkspaceStore(db, {
      onCreated: async (_tx, opened) => {
        heard.push(opened);
      },
    });
    expect(await store.create(acme, { userId: 'lee', role: 'owner' })).toEqual({
      kind: 'slug-taken',
    });
    expect(heard).toEqual([]);
  });
});
