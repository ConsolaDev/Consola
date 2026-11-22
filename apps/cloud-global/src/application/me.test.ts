import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import { schema } from '../adapters/persistence/schema.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import type { Organization, Person } from '../domain/organization.js';
import { describeMe } from './me.js';
import { ensureOrganization, joinOrganization } from './organization.js';

let db: Database;
let close: () => Promise<void>;
let stores: ReturnType<typeof createDrizzleStores>;
let org: Organization;

const dana: Person = { id: 'dana', name: 'Dana', email: 'dana@sprocket.test', image: null };

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db
    .insert(schema.user)
    .values({ id: dana.id, name: dana.name, email: dana.email, emailVerified: true });
  stores = createDrizzleStores(db);
  org = await ensureOrganization(stores.organizations, { name: 'Sprocket', slug: 'sprocket' });
});

afterEach(async () => {
  await close();
});

describe('describeMe', () => {
  it('is signed-out with nobody signed in', async () => {
    expect(await describeMe(stores.memberships, org, null)).toEqual({ kind: 'signed-out' });
  });

  it('is not-member for someone outside the organisation', async () => {
    expect(await describeMe(stores.memberships, org, dana)).toEqual({ kind: 'not-member' });
  });

  it('is member, with the role, for a member', async () => {
    await joinOrganization(stores.memberships, { organizationId: org.id, userId: dana.id });
    expect(await describeMe(stores.memberships, org, dana)).toEqual({
      kind: 'member',
      me: {
        user: { id: 'dana', name: 'Dana', email: 'dana@sprocket.test', image: null },
        organization: { id: org.id, name: 'Sprocket', slug: 'sprocket', region: 'eu' },
        role: 'owner',
      },
    });
  });
});
