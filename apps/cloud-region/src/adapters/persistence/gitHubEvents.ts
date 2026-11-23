import { eq } from 'drizzle-orm';
import type { GitHubEventStore } from '../../application/ports.js';
import type { Database } from './database.js';
import { gitHubEvents, workspaces } from './tables.js';

/**
 * GitHub's events in the `github_event` table, each for its workspace. `record` holds the
 * workspace's copy row while it writes (`for key share`), and inserts the event unless one with
 * its delivery id is there already, so the same delivery arriving twice at once is recorded once.
 */
export function createGitHubEventStore(db: Database): GitHubEventStore {
  return {
    record(event) {
      return db.transaction(async (tx) => {
        const [held] = await tx
          .select({ workspaceId: workspaces.workspaceId })
          .from(workspaces)
          .where(eq(workspaces.workspaceId, event.workspaceId))
          .for('key share');
        if (!held) return 'workspace-pending';

        const inserted = await tx
          .insert(gitHubEvents)
          .values({
            workspaceId: event.workspaceId,
            deliveryId: event.deliveryId,
            event: event.event,
            installationId: event.installationId,
            payload: JSON.stringify(event.payload),
          })
          .onConflictDoNothing()
          .returning({ deliveryId: gitHubEvents.deliveryId });
        return inserted.length > 0 ? 'recorded' : 'recorded-before';
      });
    },
  };
}
