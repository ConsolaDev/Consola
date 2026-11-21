import { randomUUID } from 'node:crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import type { MembershipStore } from '../../application/ports.js';
import type { Database } from './database.js';
import { schema } from './schema.js';

/**
 * Memberships in the `member` table. A per-organisation advisory lock makes `join`'s
 * count-then-insert safe when several sign-ins reach a real Postgres pool at once.
 */
export function createMembershipStore(db: Database): MembershipStore {
  return {
    async find(ids) {
      const [row] = await db
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, ids.organizationId),
            eq(schema.member.userId, ids.userId),
          ),
        );
      return row ?? null;
    },

    join(ids, roleFor) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${ids.organizationId}, 0))`,
        );

        const [existing] = await tx
          .select({ role: schema.member.role })
          .from(schema.member)
          .where(
            and(
              eq(schema.member.organizationId, ids.organizationId),
              eq(schema.member.userId, ids.userId),
            ),
          );
        if (existing) return existing;

        const [members] = await tx
          .select({ total: count() })
          .from(schema.member)
          .where(eq(schema.member.organizationId, ids.organizationId));
        const role = roleFor(members?.total ?? 0);

        await tx.insert(schema.member).values({
          id: randomUUID(),
          organizationId: ids.organizationId,
          userId: ids.userId,
          role,
          createdAt: new Date(),
        });
        return { role };
      });
    },
  };
}
