import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import type { Database } from '../adapters/persistence/database.js';
import { schema } from '../adapters/persistence/schema.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import { mayCreateAccount, mayStartSession } from './signIn.js';

describe('mayCreateAccount', () => {
  it('asks mayJoin', () => {
    expect(mayCreateAccount({ emailVerified: true })).toBe(true);
    expect(mayCreateAccount({ emailVerified: false })).toBe(false);
  });
});

describe('mayStartSession', () => {
  let db: Database;
  let close: () => Promise<void>;
  let stores: ReturnType<typeof createDrizzleStores>;

  beforeEach(async () => {
    ({ db, close } = openDatabase('pglite:memory'));
    await migrateDatabase(db);
    await db.insert(schema.user).values([
      { id: 'dana', name: 'Dana', email: 'dana@sprocket.test', emailVerified: true },
      { id: 'sam', name: 'Sam', email: 'sam@sprocket.test', emailVerified: false },
    ]);
    stores = createDrizzleStores(db);
  });

  afterEach(async () => {
    await close();
  });

  it('lets a person whose email is verified in', async () => {
    expect(await mayStartSession(stores.people, 'dana')).toBe(true);
  });

  it('turns away a person whose email is not verified', async () => {
    expect(await mayStartSession(stores.people, 'sam')).toBe(false);
  });

  it('turns away a person who does not exist', async () => {
    expect(await mayStartSession(stores.people, 'nobody')).toBe(false);
  });
});
