import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { schema } from './schema.js';

/**
 * Company's view of the app's one database: either driver, through drizzle's one query builder
 * and `.transaction`, typed over company's tables alone. The composition opens the database and
 * migrates its one chain (`src/persistence/database.ts`), and hands company this; company's
 * tests open one of their own (`database.test-helpers.ts`).
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** A transaction on either driver, as `Database.transaction` hands it to its callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type OpenDatabase = { db: Database; close(): Promise<void> };
