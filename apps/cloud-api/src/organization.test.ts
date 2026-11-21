import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, migrateDatabase, openDatabase } from './db/database.js';
import { schema } from './db/schema.js';
import { ensureMembership, ensureOrganization, findMembership } from './organization.js';

let db: Database;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db.insert(schema.user).values([
    { id: 'dana', name: 'Dana', email: 'dana@sprocket.test', emailVerified: true },
    { id: 'lee', name: 'Lee', email: 'lee@sprocket.test', emailVerified: true },
  ]);
});

afterEach(async () => {
  await close();
});

const sprocket = { name: 'Sprocket', slug: 'sprocket' };

describe('ensureOrganization', () => {
  it('creates the organisation when it is missing', async () => {
    const org = await ensureOrganization(db, sprocket);
    expect(org).toEqual({ id: expect.any(String), name: 'Sprocket', slug: 'sprocket' });
    expect(await db.select().from(schema.organization)).toHaveLength(1);
  });

  it('is idempotent', async () => {
    const first = await ensureOrganization(db, sprocket);
    const second = await ensureOrganization(db, sprocket);
    expect(second.id).toBe(first.id);
    expect(await db.select().from(schema.organization)).toHaveLength(1);
  });

  it('renames in place', async () => {
    const first = await ensureOrganization(db, sprocket);
    const renamed = await ensureOrganization(db, { name: 'Sprocket Labs', slug: 'sprocket' });
    expect(renamed).toEqual({ id: first.id, name: 'Sprocket Labs', slug: 'sprocket' });
  });

  it('a new slug makes a new organisation', async () => {
    const first = await ensureOrganization(db, sprocket);
    const second = await ensureOrganization(db, { name: 'Sprocket', slug: 'sprocket-2' });
    expect(second.id).not.toBe(first.id);
    expect(await db.select().from(schema.organization)).toHaveLength(2);
  });
});

describe('membership', () => {
  it('the first member is the owner and the next is a member', async () => {
    const org = await ensureOrganization(db, sprocket);
    expect(await ensureMembership(db, { organizationId: org.id, userId: 'dana' })).toEqual({
      role: 'owner',
    });
    expect(await ensureMembership(db, { organizationId: org.id, userId: 'lee' })).toEqual({
      role: 'member',
    });
  });

  it('joining again keeps the role and adds no row', async () => {
    const org = await ensureOrganization(db, sprocket);
    await ensureMembership(db, { organizationId: org.id, userId: 'dana' });
    expect(await ensureMembership(db, { organizationId: org.id, userId: 'dana' })).toEqual({
      role: 'owner',
    });
    const rows = await db.select().from(schema.member).where(eq(schema.member.userId, 'dana'));
    expect(rows).toHaveLength(1);
  });

  it('concurrent joins add one row', async () => {
    const org = await ensureOrganization(db, sprocket);
    const ids = { organizationId: org.id, userId: 'dana' };
    const roles = await Promise.all([
      ensureMembership(db, ids),
      ensureMembership(db, ids),
      ensureMembership(db, ids),
    ]);
    expect(roles).toEqual([{ role: 'owner' }, { role: 'owner' }, { role: 'owner' }]);
    const rows = await db.select().from(schema.member).where(eq(schema.member.userId, 'dana'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('owner');
  });

  it('findMembership answers null for a non-member', async () => {
    const org = await ensureOrganization(db, sprocket);
    await ensureMembership(db, { organizationId: org.id, userId: 'dana' });
    expect(await findMembership(db, { organizationId: org.id, userId: 'lee' })).toBeNull();
    expect(await findMembership(db, { organizationId: org.id, userId: 'dana' })).toEqual({
      role: 'owner',
    });
  });
});
