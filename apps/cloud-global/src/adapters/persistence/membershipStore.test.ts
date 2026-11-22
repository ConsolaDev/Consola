import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MembershipStore } from '../../application/ports.js';
import { type Organization, roleForNewMember } from '../../domain/organization.js';
import { type Database, migrateDatabase, openDatabase } from './database.js';
import { schema } from './schema.js';
import { createMembershipStore } from './membershipStore.js';
import { createOrganizationStore } from './organizationStore.js';

let db: Database;
let close: () => Promise<void>;
let memberships: MembershipStore;
let org: Organization;

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db.insert(schema.user).values([
    { id: 'dana', name: 'Dana', email: 'dana@sprocket.test', emailVerified: true },
    { id: 'lee', name: 'Lee', email: 'lee@sprocket.test', emailVerified: true },
  ]);
  memberships = createMembershipStore(db);
  org = await createOrganizationStore(db).ensure({
    name: 'Sprocket',
    slug: 'sprocket',
    region: 'eu',
  });
});

afterEach(async () => {
  await close();
});

describe('the membership store', () => {
  it('join inserts the role roleFor gives for the members already there', async () => {
    const asked: number[] = [];
    const roleFor = (existingMembers: number) => {
      asked.push(existingMembers);
      return `role-${existingMembers}`;
    };
    expect(await memberships.join({ organizationId: org.id, userId: 'dana' }, roleFor)).toEqual({
      role: 'role-0',
    });
    expect(await memberships.join({ organizationId: org.id, userId: 'lee' }, roleFor)).toEqual({
      role: 'role-1',
    });
    expect(await memberships.join({ organizationId: org.id, userId: 'dana' }, roleFor)).toEqual({
      role: 'role-0',
    });
    expect(asked).toEqual([0, 1]);
  });

  it('joining again keeps the role and adds no row', async () => {
    await memberships.join({ organizationId: org.id, userId: 'dana' }, roleForNewMember);
    expect(
      await memberships.join({ organizationId: org.id, userId: 'dana' }, roleForNewMember),
    ).toEqual({
      role: 'owner',
    });
    const rows = await db.select().from(schema.member).where(eq(schema.member.userId, 'dana'));
    expect(rows).toHaveLength(1);
  });

  it('concurrent joins add one row', async () => {
    const ids = { organizationId: org.id, userId: 'dana' };
    // PGlite runs one transaction at a time, so here the three joins queue up whatever the
    // store does. On a real Postgres pool they run at once, and the advisory lock is what keeps
    // this to one row.
    const roles = await Promise.all([
      memberships.join(ids, roleForNewMember),
      memberships.join(ids, roleForNewMember),
      memberships.join(ids, roleForNewMember),
    ]);
    expect(roles).toEqual([{ role: 'owner' }, { role: 'owner' }, { role: 'owner' }]);
    const rows = await db.select().from(schema.member).where(eq(schema.member.userId, 'dana'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('owner');
  });

  it('find answers null for a non-member', async () => {
    await memberships.join({ organizationId: org.id, userId: 'dana' }, roleForNewMember);
    expect(await memberships.find({ organizationId: org.id, userId: 'lee' })).toBeNull();
    expect(await memberships.find({ organizationId: org.id, userId: 'dana' })).toEqual({
      role: 'owner',
    });
  });
});
