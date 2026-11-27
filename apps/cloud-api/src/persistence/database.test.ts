import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
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

/** A schema as drizzle-kit reads and writes it: a snapshot in `drizzle/meta`. */
type Snapshot = Parameters<typeof generateMigration>[0];

/** The snapshot `db:generate` wrote with the chain's latest migration: the schema it last saw. */
function latestSnapshot(): Snapshot {
  const folder = new URL('../../drizzle/meta/', import.meta.url);
  const snapshots = readdirSync(folder).filter((name) => /^\d+_snapshot\.json$/.test(name));
  const latest = snapshots.sort().at(-1);
  if (!latest) throw new Error('drizzle/meta holds no snapshot.');
  return JSON.parse(readFileSync(new URL(latest, folder), 'utf8')) as Snapshot;
}

/**
 * A copy of the one schema, as drizzle-kit reads it, with a column `team` does not have: a change
 * to the schema that nobody generated a migration for.
 */
function schemaWithAColumnMore(): Snapshot {
  const changed = structuredClone(generateDrizzleJson(SCHEMA));
  const team = changed.tables['public.team'];
  if (!team) throw new Error('The schema has no team table.');
  team.columns.extra = { name: 'extra', type: 'text', primaryKey: false, notNull: false };
  return changed;
}

/**
 * What a database holds in `public`, as Postgres itself describes it: every column (its type,
 * whether it may be null, its default), every constraint with its definition (keys, foreign keys,
 * checks, uniques), every index with its definition, and every enum's values.
 */
async function catalogOf(query: (text: string) => Promise<unknown[]>) {
  return {
    columns: await query(
      `select table_name, column_name, data_type, udt_name, is_nullable, column_default,
         character_maximum_length, numeric_precision, is_identity, identity_generation,
         is_generated, generation_expression
       from information_schema.columns where table_schema = 'public'
       order by table_name, column_name`,
    ),
    constraints: await query(
      `select conrelid::regclass::text as table_name, conname, contype,
         pg_get_constraintdef(oid) as definition
       from pg_constraint where connamespace = 'public'::regnamespace
       order by 1, 2`,
    ),
    indexes: await query(
      `select tablename, indexname, indexdef from pg_indexes where schemaname = 'public'
       order by 1, 2`,
    ),
    enums: await query(
      `select t.typname, e.enumlabel from pg_type t join pg_enum e on e.enumtypid = t.oid
       where t.typnamespace = 'public'::regnamespace
       order by 1, e.enumsortorder`,
    ),
  };
}

/** The catalog of a fresh database migrated by the app's one chain, as the service's is. */
async function catalogOfTheChain(thenRun?: string) {
  const database = openDatabase('pglite:memory');
  try {
    await migrateDatabase(database);
    if (thenRun) await database.accounts.execute(sql.raw(thenRun));
    return await catalogOf((text) => rowsOf(database, sql.raw(text)));
  } finally {
    await database.close();
  }
}

/**
 * The catalog of a fresh database whose tables are made straight from `snapshot`, as the parts'
 * store tests make theirs (`database.test-helpers.ts`): drizzle-kit's migration from nothing.
 */
async function catalogBuiltFrom(snapshot: Snapshot) {
  const client = new PGlite();
  try {
    const statements = await generateMigration(generateDrizzleJson({}), snapshot);
    for (const statement of statements) await client.exec(statement);
    return await catalogOf(async (text) => (await client.query(text)).rows);
  } finally {
    await client.close();
  }
}

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

// The parts' store tests make their tables straight from the schema, and the service migrates
// the chain, so these keep the two the same: a schema change without `db:generate`, or a
// migration edited into another shape, fails here rather than passing every store test.
describe('the migration chain and the schema', () => {
  it('leaves db:generate nothing to write: the latest snapshot is the schema', async () => {
    expect(await generateMigration(latestSnapshot(), generateDrizzleJson(SCHEMA))).toEqual([]);
  });

  it('migrates a fresh database to exactly what the schema makes: columns, keys and indexes', async () => {
    const [chain, built] = await Promise.all([
      catalogOfTheChain(),
      catalogBuiltFrom(generateDrizzleJson(SCHEMA)),
    ]);
    expect(chain.columns.length).toBeGreaterThan(50);
    expect(chain.constraints.length).toBeGreaterThan(20);
    expect(chain.indexes.length).toBeGreaterThan(10);
    expect(chain).toEqual(built);
  });

  it('fails on a schema change that no migration was generated for', async () => {
    const changed = schemaWithAColumnMore();
    expect(await generateMigration(latestSnapshot(), changed)).toEqual([
      'ALTER TABLE "team" ADD COLUMN "extra" text;',
    ]);
    const [chain, built] = await Promise.all([catalogOfTheChain(), catalogBuiltFrom(changed)]);
    const extra = expect.objectContaining({ table_name: 'team', column_name: 'extra' });
    expect(built.columns).toContainEqual(extra);
    expect(chain.columns).not.toContainEqual(extra);
    expect(chain).not.toEqual(built);
  });

  it('fails on a migration edited into another shape: an index more, a key less', async () => {
    const [built, indexed, unkeyed] = await Promise.all([
      catalogBuiltFrom(generateDrizzleJson(SCHEMA)),
      catalogOfTheChain('create index "team_extra_idx" on "team" ("name")'),
      catalogOfTheChain('alter table "team_member" drop constraint "team_member_team_fk"'),
    ]);
    expect(indexed.indexes).not.toEqual(built.indexes);
    expect(indexed.constraints).toEqual(built.constraints);
    expect(unkeyed.constraints).not.toEqual(built.constraints);
    expect(unkeyed.indexes).toEqual(built.indexes);
  });
});
