import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from './database.js';
import { schema } from './schema.js';

async function tableNames(db: ReturnType<typeof openDatabase>['db']): Promise<string[]> {
  const result = (await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public'`,
  )) as { rows: { table_name: string }[] };
  return result.rows.map((row) => String(row.table_name));
}

describe('the database', () => {
  it('migrates a fresh in-memory database', async () => {
    const { db, close } = openDatabase('pglite:memory');
    await migrateDatabase(db);
    expect(await tableNames(db)).toEqual(
      expect.arrayContaining([
        'user',
        'session',
        'account',
        'verification',
        'organization',
        'member',
        'invitation',
      ]),
    );
    await close();
  });

  it('migrating twice changes nothing', async () => {
    const { db, close } = openDatabase('pglite:memory');
    await migrateDatabase(db);
    await expect(migrateDatabase(db)).resolves.toBeUndefined();
    await close();
  });

  it('keeps data in a pglite folder across reopen', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cloud-api-db-'));
    const url = `pglite:${join(folder, 'db')}`;
    try {
      const first = openDatabase(url);
      await migrateDatabase(first.db);
      await first.db
        .insert(schema.organization)
        .values({ id: 'org-1', name: 'Sprocket', slug: 'sprocket', createdAt: new Date() });
      await first.close();

      const second = openDatabase(url);
      const rows = await second.db.select().from(schema.organization);
      expect(rows.map((row) => row.slug)).toEqual(['sprocket']);
      await second.close();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('refuses an unknown scheme', () => {
    expect(() => openDatabase('mysql://x')).toThrow(/mysql/);
  });
});
