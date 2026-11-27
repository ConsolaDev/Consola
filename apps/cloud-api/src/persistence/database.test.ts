import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableName, is, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase, SCHEMA } from './database.js';
import type { OpenDatabase } from './database.js';

async function rowsOf<Row>(database: OpenDatabase, query: SQL): Promise<Row[]> {
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- the Database type's raw results are `unknown`; a type argument cannot name the rows
  return ((await database.accounts.execute(query)) as unknown as { rows: Row[] }).rows;
}

const publicTables = (database: OpenDatabase) =>
  rowsOf<{ table_name: string }>(
    database,
    sql`select table_name from information_schema.tables where table_schema = 'public'`,
  ).then((rows) => rows.map((row) => row.table_name).sort());

/** What the one schema holds: its tables, and Better Auth's relations between them. */
const declared: unknown[] = Object.values(SCHEMA);

/** Every table the one schema declares, by its name in the database. */
const declaredTables = declared
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableName(table))
  .sort();

describe('the one database', () => {
  it("declares both parts' tables in its one schema", () => {
    expect(declaredTables).toEqual(
      expect.arrayContaining(['user', 'organization', 'member', 'team', 'run', 'github_event']),
    );
  });

  it('migrates a fresh database to every table the schema declares, and no other', async () => {
    const database = openDatabase('pglite:memory');
    try {
      await migrateDatabase(database);
      expect(await publicTables(database)).toEqual(declaredTables);
    } finally {
      await database.close();
    }
  });

  it('applies every migration in the journal from empty, the latest included', async () => {
    const journal = JSON.parse(
      readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    const database = openDatabase('pglite:memory');
    try {
      await migrateDatabase(database);
      const [applied] = await rowsOf<{ count: number }>(
        database,
        sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
      );
      expect(applied?.count).toBe(journal.entries.length);
    } finally {
      await database.close();
    }
  });

  it('migrating twice changes nothing', async () => {
    const database = openDatabase('pglite:memory');
    try {
      await migrateDatabase(database);
      await expect(migrateDatabase(database)).resolves.toBeUndefined();
      expect(await publicTables(database)).toEqual(declaredTables);
    } finally {
      await database.close();
    }
  });

  it('gives both parts the one client: what one writes, the other reads', async () => {
    const database = openDatabase('pglite:memory');
    try {
      await migrateDatabase(database);
      await database.accounts.execute(
        sql`insert into "organization" (id, name, slug, region, created_at) values ('ws-1', 'Sprocket', 'sprocket', 'eu', now())`,
      );
      await database.company.execute(
        sql`insert into team (workspace_id, team_id, name, is_first) values ('ws-1', 't-1', 'General', true)`,
      );
      const [row] = await rowsOf<{ name: string }>(
        database,
        sql`select team.name from team join organization on organization.id = team.workspace_id`,
      );
      expect(row?.name).toBe('General');
    } finally {
      await database.close();
    }
  });

  it('keeps data in a pglite folder across reopen', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cloud-api-db-'));
    const url = `pglite:${join(folder, 'db')}`;
    try {
      const first = openDatabase(url);
      await migrateDatabase(first);
      await first.accounts.execute(
        sql`insert into "organization" (id, name, slug, region, created_at) values ('ws-1', 'Acme', 'acme', 'eu', now())`,
      );
      await first.close();

      const second = openDatabase(url);
      await migrateDatabase(second);
      const rows = await rowsOf<{ slug: string }>(second, sql`select slug from organization`);
      expect(rows.map((row) => row.slug)).toEqual(['acme']);
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
    const opened = openDatabase('pglite:memory');
    try {
      await expect(migrateDatabase({ ...opened })).rejects.toThrow(/openDatabase/);
    } finally {
      await opened.close();
    }
  });
});
