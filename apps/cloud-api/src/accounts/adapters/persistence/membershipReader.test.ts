import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from './database.js';
import { createMembershipReader } from './membershipReader.js';
import type { MembershipReader } from './membershipReader.js';
import { schema } from './schema.js';
import { openTestDatabase } from './testDatabase.js';

let db: Database;
let close: () => Promise<void>;
let reader: MembershipReader;

async function workspace(id: string, made: string) {
  await db
    .insert(schema.organization)
    .values({ id, name: `Workspace ${id}`, slug: id, region: 'eu', createdAt: new Date(made) });
}

async function member(workspaceId: string, userId: string, role: string, joined: string) {
  await db.insert(schema.member).values({
    id: `${workspaceId}-${userId}-${joined}`,
    organizationId: workspaceId,
    userId,
    role,
    createdAt: new Date(joined),
  });
}

const theirs = (workspaceId: string, userId: string) =>
  and(eq(schema.member.organizationId, workspaceId), eq(schema.member.userId, userId));

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  await db.insert(schema.user).values([
    { id: 'dana', name: 'Dana', email: 'dana@acme.test', emailVerified: true },
    { id: 'lee', name: 'Lee', email: 'lee@sprocket.test', emailVerified: true },
    { id: 'sam', name: 'Sam', email: 'sam@acme.test', emailVerified: true },
  ]);
  reader = createMembershipReader(db);
});

afterEach(async () => {
  await close();
});

describe('roleOf', () => {
  it("is the person's role in the workspace", async () => {
    await workspace('acme', '2026-11-01');
    await member('acme', 'dana', 'owner', '2026-11-01');
    await member('acme', 'lee', 'member', '2026-11-02');
    expect(await reader.roleOf('dana', 'acme')).toBe('owner');
    expect(await reader.roleOf('lee', 'acme')).toBe('member');
  });

  it('is null for someone outside the workspace, or a workspace that is not there', async () => {
    await workspace('acme', '2026-11-01');
    await workspace('sprocket', '2026-11-02');
    await member('acme', 'dana', 'owner', '2026-11-01');
    expect(await reader.roleOf('dana', 'sprocket')).toBeNull();
    expect(await reader.roleOf('lee', 'acme')).toBeNull();
    expect(await reader.roleOf('dana', 'gone')).toBeNull();
    expect(await reader.roleOf('nobody', 'acme')).toBeNull();
  });

  it('is null for a role stored that the app does not list', async () => {
    await workspace('acme', '2026-11-01');
    await member('acme', 'dana', 'superuser', '2026-11-01');
    await member('acme', 'lee', 'admin,member', '2026-11-02');
    expect(await reader.roleOf('dana', 'acme')).toBeNull();
    expect(await reader.roleOf('lee', 'acme')).toBeNull();
  });

  it('reads what member holds now: a new role, or none, counts at the next read', async () => {
    await workspace('acme', '2026-11-01');
    await member('acme', 'lee', 'admin', '2026-11-02');
    expect(await reader.roleOf('lee', 'acme')).toBe('admin');

    await db.update(schema.member).set({ role: 'member' }).where(theirs('acme', 'lee'));
    expect(await reader.roleOf('lee', 'acme')).toBe('member');

    await db.delete(schema.member).where(theirs('acme', 'lee'));
    expect(await reader.roleOf('lee', 'acme')).toBeNull();
  });

  it('is the role of the membership first joined, for a person in a workspace twice', async () => {
    await workspace('acme', '2026-11-01');
    await member('acme', 'dana', 'admin', '2026-11-03');
    await member('acme', 'dana', 'member', '2026-11-01');
    expect(await reader.roleOf('dana', 'acme')).toBe('member');
  });
});

describe('memberIds', () => {
  it("is the workspace's members, in the order they joined, and no one else's", async () => {
    await workspace('acme', '2026-11-01');
    await workspace('sprocket', '2026-11-02');
    await member('acme', 'lee', 'member', '2026-11-03');
    await member('acme', 'dana', 'owner', '2026-11-01');
    await member('acme', 'sam', 'admin', '2026-11-02');
    await member('sprocket', 'lee', 'owner', '2026-11-02');
    expect(await reader.memberIds('acme')).toEqual(['dana', 'sam', 'lee']);
    expect(await reader.memberIds('sprocket')).toEqual(['lee']);
    expect(await reader.memberIds('gone')).toEqual([]);
  });

  it('lists a person once, where they first joined, and not one whose role is unknown', async () => {
    await workspace('acme', '2026-11-01');
    await member('acme', 'lee', 'member', '2026-11-04');
    await member('acme', 'dana', 'owner', '2026-11-02');
    await member('acme', 'lee', 'admin', '2026-11-01');
    await member('acme', 'sam', 'superuser', '2026-11-03');
    expect(await reader.memberIds('acme')).toEqual(['lee', 'dana']);
  });
});

describe('workspaceIds', () => {
  it('is every workspace, in the order they were made', async () => {
    expect(await reader.workspaceIds()).toEqual([]);
    await workspace('sprocket', '2026-11-02');
    await workspace('acme', '2026-11-01');
    expect(await reader.workspaceIds()).toEqual(['acme', 'sprocket']);
  });
});
