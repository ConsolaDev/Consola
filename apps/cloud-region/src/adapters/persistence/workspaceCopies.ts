import { and, eq } from 'drizzle-orm';
import type { CopyStep, WorkspaceCopies } from '../../application/ports.js';
import type { Database } from './database.js';
import { workspaceMembers, workspaces } from './tables.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Moves the copy's last applied sequence from `after` to `sequence`, only if it still is
 * `after`: a compare-and-set on the workspace's row. A copy that holds nothing of the workspace
 * (`after` null) gets its row, unless another delivery made it first. Whether a row changed is
 * what says this delivery holds the move: a concurrent one waits on the row's lock, then finds
 * the sequence moved and changes nothing.
 */
async function moveSequence(tx: Transaction, step: CopyStep): Promise<boolean> {
  const { workspaceId, sequence, after } = step;
  const moved =
    after === null
      ? await tx
          .insert(workspaces)
          .values({ workspaceId, lastAppliedSequence: sequence })
          .onConflictDoNothing()
          .returning({ workspaceId: workspaces.workspaceId })
      : await tx
          .update(workspaces)
          .set({ lastAppliedSequence: sequence })
          .where(
            and(eq(workspaces.workspaceId, workspaceId), eq(workspaces.lastAppliedSequence, after)),
          )
          .returning({ workspaceId: workspaces.workspaceId });
  return moved.length === 1;
}

async function makeChange(tx: Transaction, step: CopyStep): Promise<void> {
  const { workspaceId, change } = step;
  switch (change.kind) {
    case 'open-workspace':
      // Its row, made as the sequence moved, is the whole of it.
      return;
    case 'put-member':
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId, personId: change.personId, role: change.role })
        .onConflictDoUpdate({
          target: [workspaceMembers.workspaceId, workspaceMembers.personId],
          set: { role: change.role },
        });
      return;
    case 'drop-member':
      await tx
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.personId, change.personId),
          ),
        );
      return;
  }
}

/** The workspace copies on the cell's database, each step in one transaction. */
export function createWorkspaceCopies(db: Database): WorkspaceCopies {
  return {
    async lastApplied(workspaceId) {
      const [row] = await db
        .select({ lastApplied: workspaces.lastAppliedSequence })
        .from(workspaces)
        .where(eq(workspaces.workspaceId, workspaceId));
      return row?.lastApplied ?? null;
    },

    applyAfter(step) {
      return db.transaction(async (tx) => {
        if (!(await moveSequence(tx, step))) return 'moved';
        await makeChange(tx, step);
        return 'applied';
      });
    },
  };
}
