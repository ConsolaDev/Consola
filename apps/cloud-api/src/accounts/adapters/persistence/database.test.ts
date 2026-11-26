import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { schema } from './schema.js';
import { createAccountTables, openTestDatabase } from './testDatabase.js';

// The app's one migration chain is the composition's, and its tests are there. These pin what
// accounts' own database code does with the tables accounts holds.

describe('the database', () => {
  it('keeps data in a pglite folder across reopen', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cloud-api-accounts-db-'));
    const url = `pglite:${join(folder, 'db')}`;
    try {
      const first = openDatabase(url);
      await createAccountTables(first.db);
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

  it('refuses an organisation with no region', async () => {
    const { db, close } = await openTestDatabase();
    try {
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
