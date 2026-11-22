import { and, asc, eq } from 'drizzle-orm';
import type { MembershipStore } from '../../application/ports.js';
import type { MyWorkspace } from '../../domain/workspace.js';
import type { Database } from './database.js';
import { regionOf } from './regionOf.js';
import { schema } from './schema.js';

/** Memberships in the `member` table, read with the workspace each one is in. */
export function createMembershipStore(db: Database): MembershipStore {
  const myWorkspaces = () =>
    db
      .select({
        id: schema.organization.id,
        name: schema.organization.name,
        slug: schema.organization.slug,
        region: schema.organization.region,
        role: schema.member.role,
      })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId));

  const asMine = (row: Omit<MyWorkspace, 'region'> & { region: string }): MyWorkspace => ({
    ...row,
    region: regionOf(row),
  });

  return {
    async workspaceFor(ids) {
      const [row] = await myWorkspaces().where(
        and(
          eq(schema.member.organizationId, ids.workspaceId),
          eq(schema.member.userId, ids.userId),
        ),
      );
      return row ? asMine(row) : null;
    },

    async workspacesOf(userId) {
      const rows = await myWorkspaces()
        .where(eq(schema.member.userId, userId))
        .orderBy(asc(schema.member.createdAt), asc(schema.member.id));
      return rows.map(asMine);
    },
  };
}
