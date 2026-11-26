import { and, eq } from 'drizzle-orm';
import type { CopyStep, WorkspaceCopies } from '../../application/ports.js';
import { FIRST_TEAM_NAME } from '../../domain/team.js';
import type { Database } from './database.js';
import { teamMembers, teams, workspaceMembers, workspaces } from './tables.js';

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

/**
 * Makes a step's change, and what it means for the workspace's teams (`domain/team.ts`), in the
 * step's transaction: opening a workspace makes its first team, a person who becomes a member
 * joins it, and one who stops being a member leaves every team.
 */
async function makeChange(tx: Transaction, step: CopyStep): Promise<void> {
  const { workspaceId, change } = step;
  switch (change.kind) {
    case 'open-workspace':
      // Its row was made as the sequence moved; the first team is the rest of it.
      await tx
        .insert(teams)
        .values({ workspaceId, name: FIRST_TEAM_NAME, isFirst: true })
        .onConflictDoNothing();
      return;
    case 'put-member': {
      const { personId, role } = change;
      const joined = await tx
        .insert(workspaceMembers)
        .values({ workspaceId, personId, role })
        .onConflictDoNothing()
        .returning({ personId: workspaceMembers.personId });
      if (joined.length === 0) {
        // A member already: only the role moves, and their teams stay as they are.
        await tx
          .update(workspaceMembers)
          .set({ role })
          .where(
            and(
              eq(workspaceMembers.workspaceId, workspaceId),
              eq(workspaceMembers.personId, personId),
            ),
          );
        return;
      }
      const [first] = await tx
        .select({ teamId: teams.teamId })
        .from(teams)
        .where(and(eq(teams.workspaceId, workspaceId), eq(teams.isFirst, true)));
      if (first) {
        await tx
          .insert(teamMembers)
          .values({ workspaceId, teamId: first.teamId, personId })
          .onConflictDoNothing();
      }
      return;
    }
    case 'drop-member':
      // Their places in the workspace's teams go with this row (`team_member`'s foreign key).
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
