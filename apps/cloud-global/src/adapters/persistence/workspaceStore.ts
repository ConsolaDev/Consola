import { randomUUID } from 'node:crypto';
import type { WorkspaceStore } from '../../application/ports.js';
import type { Database } from './database.js';
import { writeWorkspaceChange } from './workspaceChanges.js';

/**
 * Workspaces in Better Auth's `organization` table. `create` writes the row and its first member
 * in one transaction, each with its outbox message (`workspace.created`, then `member.added`), so
 * the workspace, its owner and both messages commit together or not at all. The slug's unique
 * index covers every region, since every workspace is in this one table, and a slug already
 * there makes the insert do nothing rather than fail, so two people asking for one slug at once
 * get one workspace and one `slug-taken`. Once a workspace is made, `messageWritten` is told, so
 * the outbox's worker can deliver at once rather than at its next poll.
 */
export function createWorkspaceStore(
  db: Database,
  hooks: { messageWritten?: () => void } = {},
): WorkspaceStore {
  return {
    async create(workspace, firstMember) {
      const id = randomUUID();
      const made = await db.transaction(async (tx) => {
        const created = await writeWorkspaceChange(tx, {
          workspace: { id, ...workspace },
          change: { type: 'workspace.created' },
        });
        if (!created) return { kind: 'slug-taken' as const };

        const added = await writeWorkspaceChange(tx, {
          workspaceId: id,
          change: { type: 'member.added', personId: firstMember.userId, role: firstMember.role },
        });
        if (!added) throw new Error(`The new workspace ${workspace.slug} had a member already.`);
        const { name, slug } = workspace;
        return { kind: 'created' as const, workspace: { id, name, slug, region: created.region } };
      });
      if (made.kind === 'created') hooks.messageWritten?.();
      return made;
    },
  };
}
