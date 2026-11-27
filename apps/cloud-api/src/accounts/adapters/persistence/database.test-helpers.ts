import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { sql } from 'drizzle-orm';
import { openMemoryDatabase } from './database.js';
import type { Database, OpenDatabase } from './database.js';
import { schema } from './schema.js';

// For tests only, and never imported by the service.

let statements: Promise<string[]> | undefined;

/**
 * Makes accounts' tables in `db`, straight from `schema`, as drizzle-kit writes them into the
 * app's one migration chain. Accounts' tests stand on accounts' tables alone, whatever else the
 * chain holds, so they never wait on another part's tables or migrations.
 */
export async function createAccountTables(db: Database): Promise<void> {
  statements ??= generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
  for (const statement of await statements) await db.execute(sql.raw(statement));
}

/** A fresh in-memory database holding accounts' tables, and nothing else. */
export async function openTestDatabase(): Promise<OpenDatabase> {
  const opened = openMemoryDatabase();
  await createAccountTables(opened.db);
  return opened;
}
