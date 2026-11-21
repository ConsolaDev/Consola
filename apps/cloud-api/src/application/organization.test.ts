import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import { schema } from '../adapters/persistence/schema.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import { ensureOrganization, joinOrganization } from './organization.js';

let db: Database;
let close: () => Promise<void>;
let stores: ReturnType<typeof createDrizzleStores>;

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db.insert(schema.user).values([
    { id: 'dana', name: 'Dana', email: 'dana@sprocket.test', emailVerified: true },
    { id: 'lee', name: 'Lee', email: 'lee@sprocket.test', emailVerified: true },
  ]);
  stores = createDrizzleStores(db);
});

afterEach(async () => {
  await close();
});

const sprocket = { name: 'Sprocket', slug: 'sprocket' };

describe('joinOrganization', () => {
  it('the first member is the owner and the next is a member', async () => {
    const org = await ensureOrganization(stores.organizations, sprocket);
    expect(
      await joinOrganization(stores.memberships, { organizationId: org.id, userId: 'dana' }),
    ).toEqual({
      role: 'owner',
    });
    expect(
      await joinOrganization(stores.memberships, { organizationId: org.id, userId: 'lee' }),
    ).toEqual({
      role: 'member',
    });
  });
});
