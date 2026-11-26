import { and, asc, eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { isWorkspaceRole } from '../../../shared/workspaceRole.js';
import type { WorkspaceRole } from '../../../shared/workspaceRole.js';
import type { Database } from './database.js';
import { schema } from './schema.js';

/**
 * Who belongs to which workspace, by ids alone, as the company part reads it: the shape of its
 * `MembershipReader` port, which the composition hands it this. Accounts imports nothing of the
 * company part, so the two agree by shape, and TypeScript checks them where they meet.
 */
export type MembershipReader = {
  /** The person's role in the workspace, or null when they are not a member of it. */
  roleOf(personId: string, workspaceId: string): Promise<WorkspaceRole | null>;
  /** The ids of the workspace's members, in the order they joined it. */
  memberIds(workspaceId: string): Promise<readonly string[]>;
  /** The id of every workspace there is, in the order they were made. */
  workspaceIds(): Promise<readonly string[]>;
};

/**
 * Better Auth's `member` and `organization` rows, read live on every call, so a role changed or
 * a member removed counts at the very next read. Nothing of a person but their id leaves here:
 * no name, no email (rule 2).
 *
 * A row counts only with a role of `WORKSPACE_ROLES`. One with any other value is a row nothing
 * here wrote, and it reads as no membership (null), so a role nobody knows grants nothing.
 * Nothing in the table stops two rows for one person in a workspace: the first they joined by
 * is the one that counts, and they are listed once.
 */
export function createMembershipReader(db: Database): MembershipReader {
  /** The memberships `where` picks that have a listed role, first joined first. */
  const memberships = async (where: SQL | undefined) => {
    const rows = await db
      .select({ personId: schema.member.userId, role: schema.member.role })
      .from(schema.member)
      .where(where)
      .orderBy(asc(schema.member.createdAt), asc(schema.member.id));
    return rows.flatMap(({ personId, role }) =>
      isWorkspaceRole(role) ? [{ personId, role }] : [],
    );
  };

  return {
    async roleOf(personId, workspaceId) {
      const [first] = await memberships(
        and(eq(schema.member.organizationId, workspaceId), eq(schema.member.userId, personId)),
      );
      return first?.role ?? null;
    },

    async memberIds(workspaceId) {
      const rows = await memberships(eq(schema.member.organizationId, workspaceId));
      return [...new Set(rows.map((row) => row.personId))];
    },

    async workspaceIds() {
      const rows = await db
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .orderBy(asc(schema.organization.createdAt), asc(schema.organization.id));
      return rows.map((row) => row.id);
    },
  };
}
