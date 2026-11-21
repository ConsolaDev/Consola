import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import { schema } from './schema.js';

/** Either driver, through drizzle's one query builder and `.transaction`. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export type OpenDatabase = { db: Database; close(): Promise<void> };

// Resolves from both `src/db` and `dist/db`.
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

type Driver = 'pglite' | 'pg';

// Which driver backs a database, so `migrateDatabase` picks the matching migrator.
const drivers = new WeakMap<object, Driver>();

const PGLITE_PREFIX = 'pglite:';

export function openDatabase(url: string): OpenDatabase {
  if (url.startsWith(PGLITE_PREFIX)) {
    const location = url.slice(PGLITE_PREFIX.length);
    if (location === '') throw new Error('A pglite: database needs "memory" or a folder path.');
    let client: PGlite;
    if (location === 'memory') {
      client = new PGlite();
    } else {
      mkdirSync(dirname(location), { recursive: true });
      client = new PGlite(location);
    }
    const db = drizzlePglite(client, { schema }) as unknown as Database;
    drivers.set(db, 'pglite');
    return { db, close: () => client.close() };
  }

  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pool = new pg.Pool({ connectionString: url });
    // An idle connection that breaks (Postgres restarting, say) is reported here, and an
    // unheard 'error' would end the process. The pool opens a new connection when next asked.
    pool.on('error', (error) => {
      console.error(`A database connection was lost: ${error.message.split('\n')[0]}`);
    });
    const db = drizzleNodePg(pool, { schema }) as unknown as Database;
    drivers.set(db, 'pg');
    return { db, close: () => pool.end() };
  }

  const scheme = url.split(':')[0] ?? url;
  throw new Error(
    `Unsupported database scheme "${scheme}". Use pglite:memory, pglite:<path>, postgres:// or postgresql://.`,
  );
}

export async function migrateDatabase(db: Database): Promise<void> {
  const driver = drivers.get(db);
  if (!driver) throw new Error('This database was not opened with openDatabase.');
  if (driver === 'pglite') {
    await migratePglite(db as unknown as Parameters<typeof migratePglite>[0], {
      migrationsFolder: MIGRATIONS_FOLDER,
    });
  } else {
    await migrateNodePg(db as unknown as Parameters<typeof migrateNodePg>[0], {
      migrationsFolder: MIGRATIONS_FOLDER,
    });
  }
}
