import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/pglite';
import type { Database, OpenDatabase } from './database.js';
import { schema } from './schema.js';

/**
 * The statements that make company's tables from nothing, as drizzle-kit writes a migration:
 * its diff from an empty schema to `tables.ts`. Worked out once, for every database a test opens.
 */
const statements: Promise<string[]> = (() => {
  const empty = generateDrizzleJson({});
  return generateMigration(empty, generateDrizzleJson({ ...schema }, empty.id));
})();

/**
 * A fresh in-memory database holding company's tables and no other, for the tests of its stores
 * and use cases. The tables are made from `tables.ts` itself, by the statements a migration of it
 * would hold, so a test reads and writes exactly the tables the stores are typed over, and none of
 * accounts' (the app's one chain, `drizzle/`, holds both parts', and `migrateDatabase` applies it).
 * Never for anything but a test: drizzle-kit is a development dependency.
 */
export async function openTestDatabase(): Promise<OpenDatabase> {
  const client = new PGlite();
  for (const statement of await statements) await client.exec(statement);
  const db = drizzle(client, { schema }) as unknown as Database;
  return { db, close: () => client.close() };
}
