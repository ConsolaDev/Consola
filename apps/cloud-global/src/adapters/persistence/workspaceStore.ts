import { randomUUID } from 'node:crypto';
import type { WorkspaceStore } from '../../application/ports.js';
import { regionOf } from './regionOf.js';
import type { Database } from './database.js';
import { schema } from './schema.js';

/**
 * Workspaces in Better Auth's `organization` table. `create` writes the row and its first member
 * in one transaction. The slug's unique index covers every region, since every workspace is in
 * this one table, and a slug already there makes the insert do nothing rather than fail, so two
 * people asking for one slug at once get one workspace and one `slug-taken`.
 */
export function createWorkspaceStore(db: Database): WorkspaceStore {
  return {
    create(workspace, firstMember) {
      return db.transaction(async (tx) => {
        const now = new Date();
        const [row] = await tx
          .insert(schema.organization)
          .values({
            id: randomUUID(),
            name: workspace.name,
            slug: workspace.slug,
            region: workspace.region,
            createdAt: now,
          })
          .onConflictDoNothing({ target: schema.organization.slug })
          .returning({
            id: schema.organization.id,
            name: schema.organization.name,
            slug: schema.organization.slug,
            region: schema.organization.region,
          });
        if (!row) return { kind: 'slug-taken' as const };

        await tx.insert(schema.member).values({
          id: randomUUID(),
          organizationId: row.id,
          userId: firstMember.userId,
          role: firstMember.role,
          createdAt: now,
        });
        return { kind: 'created' as const, workspace: { ...row, region: regionOf(row) } };
      });
    },
  };
}
