import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { FIRST_TEAM_NAME } from '../../domain/team.js';
import { migrateDatabase, openDatabase } from './database.js';
import type { Database } from './database.js';
import { teamMembers, teams, workspaceMembers, workspaces } from './tables.js';

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url));

type Journal = { entries: Array<{ tag: string }> };

/** A migrations folder holding only the migrations up to and including `lastTag`. */
function migrationsUpTo(lastTag: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'cell-migrations-'));
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (last < 0) throw new Error(`No migration is tagged ${lastTag}`);
  const entries = journal.entries.slice(0, last + 1);
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const { tag } of entries)
    copyFileSync(join(MIGRATIONS, `${tag}.sql`), join(folder, `${tag}.sql`));
  return folder;
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('the teams migration', () => {
  it('gives every workspace the cell held before it a first team, holding its members', async () => {
    const before = migrationsUpTo('0000_workspace_copy');
    cleanups.push(() => rmSync(before, { recursive: true, force: true }));
    const { db, close } = openDatabase('pglite:memory');
    cleanups.push(close);

    await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder: before });
    await db.insert(workspaces).values([
      { workspaceId: 'acme', lastAppliedSequence: 3 },
      { workspaceId: 'sprocket', lastAppliedSequence: 1 },
    ]);
    await db.insert(workspaceMembers).values([
      { workspaceId: 'acme', personId: 'person-dana', role: 'owner' },
      { workspaceId: 'acme', personId: 'person-eli', role: 'member' },
    ]);

    await migrateDatabase(db as Database);

    const made = await db
      .select({ workspaceId: teams.workspaceId, name: teams.name, first: teams.isFirst })
      .from(teams)
      .orderBy(asc(teams.workspaceId));
    expect(made).toEqual([
      { workspaceId: 'acme', name: FIRST_TEAM_NAME, first: true },
      { workspaceId: 'sprocket', name: FIRST_TEAM_NAME, first: true },
    ]);
    const places = await db
      .select({ workspaceId: teamMembers.workspaceId, personId: teamMembers.personId })
      .from(teamMembers)
      .orderBy(asc(teamMembers.personId));
    expect(places).toEqual([
      { workspaceId: 'acme', personId: 'person-dana' },
      { workspaceId: 'acme', personId: 'person-eli' },
    ]);
  });

  it('names the first team as the domain does', () => {
    const sql = readFileSync(join(MIGRATIONS, '0001_teams.sql'), 'utf8');
    expect(sql).toContain(`'${FIRST_TEAM_NAME}', true`);
  });
});
