import { describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from './database.js';
import { createHealthProbe } from './healthProbe.js';

describe('the health probe', () => {
  it('says the database answers while it is open', async () => {
    const { db, close } = openDatabase('pglite:memory');
    await migrateDatabase(db);
    await expect(createHealthProbe(db).databaseAnswers()).resolves.toBe(true);
    await close();
  });

  it('says it does not once the database is closed, without throwing', async () => {
    const { db, close } = openDatabase('pglite:memory');
    await migrateDatabase(db);
    await close();
    await expect(createHealthProbe(db).databaseAnswers()).resolves.toBe(false);
  });
});
