import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { createHealthProbe } from './healthProbe.js';

describe('the health probe', () => {
  it('says the database answers while it is open', async () => {
    const { db, close } = openDatabase('pglite:memory');
    await expect(createHealthProbe(db).databaseAnswers()).resolves.toBe(true);
    await close();
  });

  it('says it does not once the database is closed, without throwing', async () => {
    const { db, close } = openDatabase('pglite:memory');
    await close();
    await expect(createHealthProbe(db).databaseAnswers()).resolves.toBe(false);
  });
});
