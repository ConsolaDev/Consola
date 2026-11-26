import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/pglite';
import type { WorkspaceRole } from '../../../shared/workspaceRole.js';
import type { FakeMembership } from '../../application/testMembership.js';
import type { Database, OpenDatabase } from './database.js';
import { schema } from './schema.js';
import { createTeamStore, openWorkspace } from './teams.js';

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

/**
 * Waits for the database's clock to move on. A place in a team is ordered by when it was made,
 * and PGlite's clock counts milliseconds, so two people who join one after the other within a
 * millisecond would tie, and read back by id instead.
 */
export function nextMillisecond(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2));
}

/**
 * Makes `workspaceId` for a test as making a workspace does (`openWorkspace`), its first member
 * its owner, then puts every other member in its first team, as each would join it once members
 * can be added. `membership` hears every one, so company's reads of accounts' `member` find them.
 */
export async function makeTestWorkspace(
  db: Database,
  membership: FakeMembership,
  workspaceId: string,
  members: ReadonlyArray<readonly [personId: string, role: WorkspaceRole]>,
): Promise<void> {
  const [owner, ...others] = members;
  if (!owner) throw new Error(`${workspaceId} needs an owner`);
  await db.transaction((tx) => openWorkspace(tx, { workspaceId, ownerId: owner[0] }));
  const teams = createTeamStore(db);
  const first = (await teams.list(workspaceId)).find((team) => team.first);
  if (!first) throw new Error(`${workspaceId} has no first team`);
  for (const [personId, role] of members) membership.put(workspaceId, personId, role);
  for (const [personId] of others) {
    await nextMillisecond();
    await teams.addMember(workspaceId, first.id, personId);
  }
}
