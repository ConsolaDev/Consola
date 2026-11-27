import { describe, expect, it } from 'vitest';
import { createHealthProbe } from './healthProbe.js';
import { openTestDatabase } from './database.test-helpers.js';

describe('the health probe', () => {
  it('says the database answers while it is open', async () => {
    const { db, close } = await openTestDatabase();
    await expect(createHealthProbe(db).databaseAnswers()).resolves.toBe(true);
    await close();
  });

  it('says it does not once the database is closed, without throwing', async () => {
    const { db, close } = await openTestDatabase();
    await close();
    await expect(createHealthProbe(db).databaseAnswers()).resolves.toBe(false);
  });
});
