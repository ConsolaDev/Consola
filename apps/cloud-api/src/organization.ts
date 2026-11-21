import { randomUUID } from 'node:crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import type { Database } from './db/database.js';
import { schema } from './db/schema.js';

export type Organization = { id: string; name: string; slug: string };

/**
 * The deployment's one organisation, by slug. A new name renames it in place; a new slug is a
 * new organisation. One statement, so two processes starting together cannot both insert.
 */
export async function ensureOrganization(
  db: Database,
  wanted: { name: string; slug: string },
): Promise<Organization> {
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
}

/**
 * Joins the organisation: the first member becomes its owner, later ones are members, and
 * joining again changes nothing. A per-organisation advisory lock makes the count-then-insert
 * safe when several sign-ins reach a real Postgres pool at once.
 */
export async function ensureMembership(
  db: Database,
  ids: { organizationId: string; userId: string },
): Promise<{ role: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ids.organizationId}, 0))`);

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
    const role = (members?.total ?? 0) === 0 ? 'owner' : 'member';

    await tx.insert(schema.member).values({
      id: randomUUID(),
      organizationId: ids.organizationId,
      userId: ids.userId,
      role,
      createdAt: new Date(),
    });
    return { role };
  });
}

export async function findMembership(
  db: Database,
  ids: { organizationId: string; userId: string },
): Promise<{ role: string } | null> {
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
}
