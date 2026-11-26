import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { WorkspaceStore } from '../../application/ports.js';
import type { Database, Transaction } from './database.js';
import { regionOf } from './regionOf.js';
import { schema } from './schema.js';

/** A workspace just made, as `onCreated` is told of it: its id, and its owner's. */
export type OpenedWorkspace = { workspaceId: string; ownerId: string };

export type WorkspaceStoreHooks = {
  /**
   * Runs inside the transaction that makes a workspace, after its `organization` row and its
   * owner's `member` row, so what it writes commits with them or not at all: the composition
   * hands in the company part's opening of the workspace (its first team). One that throws
   * undoes the workspace, and `create` rejects with its error.
   */
  onCreated?: (tx: Transaction, opened: OpenedWorkspace) => Promise<void>;
};

/**
 * Workspaces in Better Auth's `organization` table. `create` writes the row, its first member
 * and whatever `onCreated` writes in one transaction, so a workspace is never left without its
 * owner. The slug's unique index covers every workspace, since every one is in this one table,
 * and a slug already there makes the insert do nothing rather than fail, so two people asking
 * for one slug at once get one workspace and one `slug-taken`, and the second writes nothing.
 *
 * `setIcon` sets `logo` alone, never the name, slug or region.
 */
export function createWorkspaceStore(db: Database, hooks: WorkspaceStoreHooks = {}): WorkspaceStore {
  return {
    create(workspace, firstMember) {
      const id = randomUUID();
      const now = new Date();
      return db.transaction(async (tx) => {
        const { name, slug, region } = workspace;
        const [row] = await tx
          .insert(schema.organization)
          .values({ id, name, slug, region, createdAt: now })
          .onConflictDoNothing({ target: schema.organization.slug })
          .returning({ slug: schema.organization.slug, region: schema.organization.region });
        if (!row) return { kind: 'slug-taken' as const };

        await tx.insert(schema.member).values({
          id: randomUUID(),
          organizationId: id,
          userId: firstMember.userId,
          role: firstMember.role,
          createdAt: now,
        });
        await hooks.onCreated?.(tx, { workspaceId: id, ownerId: firstMember.userId });
        return { kind: 'created' as const, workspace: { id, name, slug, region: regionOf(row) } };
      });
    },

    async setIcon({ workspaceId, icon }) {
      await db
        .update(schema.organization)
        .set({ logo: icon })
        .where(eq(schema.organization.id, workspaceId));
    },
  };
}
