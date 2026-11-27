import { PGlite } from '@electric-sql/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { schema } from './schema.js';

/**
 * Accounts' view of the app's one database: either driver, through drizzle's one query builder
 * and `.transaction`, typed over accounts' tables alone. The composition opens the database and
 * migrates its one chain (`src/persistence/database.ts`), and hands accounts this.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** A transaction on either driver, as `Database.transaction` hands it to its callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type OpenDatabase = { db: Database; close(): Promise<void> };

/**
 * A database in memory, typed over accounts' tables, with none of them made: for Better Auth's
 * schema CLI (`cli-config.ts`), which never queries it, and for accounts' tests, which make the
 * tables they stand on (`database.test-helpers.ts`). Never the service's: that is the
 * composition's.
 */
export function openMemoryDatabase(): OpenDatabase {
  const client = new PGlite();
  return {
    db: drizzle(client, { schema }),
    close: () => client.close(),
  };
}
