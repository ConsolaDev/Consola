import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openTestDatabase } from './testDatabase.js';

// The app's one database and its one migration chain are the composition's, and their tests are
// there (`src/persistence/database.test.ts`). This pins what accounts' own tables refuse.

describe("accounts' tables", () => {
  it('refuse an organisation with no region', async () => {
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
});
