import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { type Database, migrateDatabase, openDatabase } from './database.js';
import { schema } from './schema.js';

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url));

type Journal = { entries: { idx: number; tag: string }[] };

/** Applies the migrations up to and including `lastTag`, as a database made back then had. */
async function migrateUpTo(db: Database, lastTag: string): Promise<void> {
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (last === -1) throw new Error(`No migration is tagged ${lastTag}.`);
  const entries = journal.entries.slice(0, last + 1);
  const folder = await mkdtemp(join(tmpdir(), 'cloud-global-migrations-'));
  try {
    await mkdir(join(folder, 'meta'));
    await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) {
      await copyFile(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

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
    const folder = await mkdtemp(join(tmpdir(), 'cloud-global-db-'));
    const url = `pglite:${join(folder, 'db')}`;
    try {
      const first = openDatabase(url);
      await migrateDatabase(first.db);
      await first.db.insert(schema.organization).values({
        id: 'org-1',
        name: 'Sprocket',
        slug: 'sprocket',
        region: 'eu',
        createdAt: new Date(),
      });
      await first.close();

      const second = openDatabase(url);
      const rows = await second.db.select().from(schema.organization);
      expect(rows.map((row) => row.slug)).toEqual(['sprocket']);
      await second.close();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('puts an organisation made before regions existed in eu', async () => {
    const { db, close } = openDatabase('pglite:memory');
    try {
      await migrateUpTo(db, '0000_futuristic_luckman');
      await db.execute(
        sql`insert into "organization" (id, name, slug, created_at) values ('org-1', 'Sprocket', 'sprocket', now())`,
      );

      await migrateDatabase(db);

      const rows = await db.select().from(schema.organization);
      expect(rows.map((row) => [row.slug, row.region])).toEqual([['sprocket', 'eu']]);
    } finally {
      await close();
    }
  });

  it('refuses an organisation with no region', async () => {
    const { db, close } = openDatabase('pglite:memory');
    try {
      await migrateDatabase(db);
      await expect(
        db.execute(
          sql`insert into "organization" (id, name, slug, created_at) values ('org-1', 'Sprocket', 'sprocket', now())`,
        ),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it('refuses an unknown scheme', () => {
    expect(() => openDatabase('mysql://x')).toThrow(/mysql/);
  });
});
