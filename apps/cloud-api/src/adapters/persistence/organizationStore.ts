import { randomUUID } from 'node:crypto';
import type { OrganizationStore } from '../../application/ports.js';
import type { Database } from './database.js';
import { schema } from './schema.js';

/**
 * Organisations in the `organization` table, by slug. `ensure` is one statement, so two
 * processes starting together cannot both insert.
 */
export function createOrganizationStore(db: Database): OrganizationStore {
  return {
    async ensure(wanted) {
      const [row] = await db
        .insert(schema.organization)
        .values({ id: randomUUID(), name: wanted.name, slug: wanted.slug, createdAt: new Date() })
        .onConflictDoUpdate({ target: schema.organization.slug, set: { name: wanted.name } })
        .returning({
          id: schema.organization.id,
          name: schema.organization.name,
          slug: schema.organization.slug,
        });
      if (!row) throw new Error('The organisation could not be saved.');
      return row;
    },
  };
}
