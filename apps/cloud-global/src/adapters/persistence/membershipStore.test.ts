import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MembershipStore } from '../../application/ports.js';
import { type Database, migrateDatabase, openDatabase } from './database.js';
import { createMembershipStore } from './membershipStore.js';
import { schema } from './schema.js';

let db: Database;
let close: () => Promise<void>;
let memberships: MembershipStore;

async function workspace(id: string, region = 'eu') {
  await db
    .insert(schema.organization)
    .values({ id, name: `Workspace ${id}`, slug: id, region, createdAt: new Date() });
}

async function member(workspaceId: string, userId: string, role: string, joined: string) {
  await db.insert(schema.member).values({
    id: `${workspaceId}-${userId}`,
    organizationId: workspaceId,
    userId,
    role,
    createdAt: new Date(joined),
  });
}

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db.insert(schema.user).values([
    { id: 'dana', name: 'Dana', email: 'dana@acme.test', emailVerified: true },
    { id: 'lee', name: 'Lee', email: 'lee@sprocket.test', emailVerified: true },
  ]);
  memberships = createMembershipStore(db);
});

afterEach(async () => {
  await close();
});

describe('the membership store', () => {
  it('workspaceFor is the workspace with the role, for a member', async () => {
    await workspace('acme', 'us');
    await member('acme', 'dana', 'owner', '2026-11-01');
    expect(await memberships.workspaceFor({ workspaceId: 'acme', userId: 'dana' })).toEqual({
      id: 'acme',
      name: 'Workspace acme',
      slug: 'acme',
      region: 'us',
      role: 'owner',
      icon: null,
    });
  });

  it('workspaceFor is null for someone outside it, or a workspace that is not there', async () => {
    await workspace('acme');
    await member('acme', 'dana', 'owner', '2026-11-01');
    expect(await memberships.workspaceFor({ workspaceId: 'acme', userId: 'lee' })).toBeNull();
    expect(await memberships.workspaceFor({ workspaceId: 'gone', userId: 'dana' })).toBeNull();
  });

  it('workspacesOf lists only the person’s workspaces, in the order they joined', async () => {
    await workspace('sprocket');
    await workspace('acme');
    await workspace('elsewhere');
    await member('sprocket', 'dana', 'member', '2026-11-03');
    await member('acme', 'dana', 'owner', '2026-11-01');
    await member('elsewhere', 'lee', 'owner', '2026-11-02');

    expect(await memberships.workspacesOf('dana')).toEqual([
      expect.objectContaining({ id: 'acme', role: 'owner' }),
      expect.objectContaining({ id: 'sprocket', role: 'member' }),
    ]);
    expect(await memberships.workspacesOf('lee')).toEqual([
      expect.objectContaining({ id: 'elsewhere', role: 'owner' }),
    ]);
    expect(await memberships.workspacesOf('nobody')).toEqual([]);
  });

  it('membersOf lists a workspace’s members with their roles, in the order they joined', async () => {
    await workspace('acme');
    await workspace('sprocket');
    await member('acme', 'lee', 'member', '2026-11-03');
    await member('acme', 'dana', 'owner', '2026-11-01');
    await member('sprocket', 'lee', 'owner', '2026-11-02');
    expect(await memberships.membersOf('acme')).toEqual([
      { id: 'dana', name: 'Dana', email: 'dana@acme.test', image: null, role: 'owner' },
      { id: 'lee', name: 'Lee', email: 'lee@sprocket.test', image: null, role: 'member' },
    ]);
    expect(await memberships.membersOf('gone')).toEqual([]);
  });

  it('membersOf refuses a member stored with an unknown role', async () => {
    await workspace('acme');
    await member('acme', 'dana', 'admin,member', '2026-11-01');
    await expect(memberships.membersOf('acme')).rejects.toThrow(/acme has an unknown role/);
  });

  it('refuses a membership stored with an unknown role', async () => {
    await workspace('acme');
    await member('acme', 'dana', 'superuser', '2026-11-01');
    await expect(memberships.workspacesOf('dana')).rejects.toThrow(/unknown role, "superuser"/);
  });

  it('refuses a workspace stored in an unknown region', async () => {
    await workspace('acme');
    await member('acme', 'dana', 'owner', '2026-11-01');
    await db
      .update(schema.organization)
      .set({ region: 'ap' })
      .where(eq(schema.organization.id, 'acme'));
    await expect(memberships.workspacesOf('dana')).rejects.toThrow(/unknown region, "ap"/);
    await expect(memberships.workspaceFor({ workspaceId: 'acme', userId: 'dana' })).rejects.toThrow(
      /unknown region, "ap"/,
    );
  });
});
