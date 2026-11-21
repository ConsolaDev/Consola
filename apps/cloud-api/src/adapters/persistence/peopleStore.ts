import { eq } from 'drizzle-orm';
import type { PeopleStore } from '../../application/ports.js';
import type { Database } from './database.js';
import { schema } from './schema.js';

/** People in Better Auth's `user` table, read as they are stored now. */
export function createPeopleStore(db: Database): PeopleStore {
  return {
    async emailVerified(userId) {
      const [user] = await db
        .select({ emailVerified: schema.user.emailVerified })
        .from(schema.user)
        .where(eq(schema.user.id, userId));
      return user ? user.emailVerified : null;
    },
  };
}
