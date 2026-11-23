import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { type Database, migrateDatabase, openDatabase } from './database.js';

async function rowsOf<Row>(db: Database, query: ReturnType<typeof sql>): Promise<Row[]> {
  return ((await db.execute(query)) as unknown as { rows: Row[] }).rows;
}

describe('the database', () => {
  it('migrates a fresh in-memory database', async () => {
    const { db, close } = openDatabase('pglite:memory');
    await migrateDatabase(db);
    const ledgers = await rowsOf<{ table_name: string }>(
      db,
      sql`select table_name from information_schema.tables where table_schema = 'drizzle'`,
    );
    expect(ledgers.map((row) => row.table_name)).toEqual(['__drizzle_migrations']);
    await close();
  });

  it('applies every migration in the journal from empty, the latest included', async () => {
    const journal = JSON.parse(
      readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: { tag: string }[] };
    const { db, close } = openDatabase('pglite:memory');
    await migrateDatabase(db);
    const [applied] = await rowsOf<{ count: number }>(
      db,
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    expect(applied?.count).toBe(journal.entries.length);
    const tables = await rowsOf<{ table_name: string }>(
      db,
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    // The tables of the last three migrations: the runs', their approvals', then the cloud
    // sessions'.
    expect(tables.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(['run', 'run_approval', 'cloud_session']),
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
    const folder = await mkdtemp(join(tmpdir(), 'cloud-region-db-'));
    const url = `pglite:${join(folder, 'db')}`;
    try {
      const first = openDatabase(url);
      await migrateDatabase(first.db);
      await first.db.execute(sql`create table kept (workspace_id text not null)`);
      await first.db.execute(sql`insert into kept values ('ws-1')`);
      await first.close();

      const second = openDatabase(url);
      const rows = await rowsOf<{ workspace_id: string }>(second.db, sql`select * from kept`);
      expect(rows.map((row) => row.workspace_id)).toEqual(['ws-1']);
      await second.close();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('refuses an unknown scheme', () => {
    expect(() => openDatabase('mysql://x')).toThrow(/mysql/);
  });

  it('refuses a pglite address with no location', () => {
    expect(() => openDatabase('pglite:')).toThrow(/memory/);
  });

  it('refuses to migrate a database it did not open', async () => {
    await expect(migrateDatabase({} as Database)).rejects.toThrow(/openDatabase/);
  });
});
