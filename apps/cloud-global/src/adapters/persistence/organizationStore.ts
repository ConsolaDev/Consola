import { randomUUID } from 'node:crypto';
import type { OrganizationStore } from '../../application/ports.js';
import { isRegion } from '../../domain/region.js';
import type { Database } from './database.js';
import { schema } from './schema.js';

/**
 * Organisations in the `organization` table, by slug. `ensure` is one statement, so two
 * processes starting together cannot both insert. The region is written only when the row is
 * made: a name changes on conflict, the region never does.
 */
export function createOrganizationStore(db: Database): OrganizationStore {
  return {
    async ensure(wanted) {
      const [row] = await db
        .insert(schema.organization)
        .values({
          id: randomUUID(),
          name: wanted.name,
          slug: wanted.slug,
          region: wanted.region,
          createdAt: new Date(),
        })
        .onConflictDoUpdate({ target: schema.organization.slug, set: { name: wanted.name } })
        .returning({
          id: schema.organization.id,
          name: schema.organization.name,
          slug: schema.organization.slug,
          region: schema.organization.region,
        });
      if (!row) throw new Error('The organisation could not be saved.');
      if (!isRegion(row.region)) {
        throw new Error(`The organisation ${row.slug} is in an unknown region, "${row.region}".`);
      }
      return { ...row, region: row.region };
    },
  };
}
