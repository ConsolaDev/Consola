import type { GitHubEventStore } from '../../application/gitHubPorts.js';
import type { GitHubDatabase } from './gitHubStores.js';
import { gitHubEvents } from './gitHubTables.js';

/**
 * GitHub's events in the `github_event` table, each for its workspace. `record` inserts the
 * event unless one with its delivery id is there for the workspace already, in one statement
 * keyed by both (on conflict do nothing), so the same delivery arriving twice, at once or later,
 * is recorded once.
 */
export function createGitHubEventStore(db: GitHubDatabase): GitHubEventStore {
  return {
    async record(event) {
      const inserted = await db
        .insert(gitHubEvents)
        .values({
          workspaceId: event.workspaceId,
          deliveryId: event.deliveryId,
          event: event.event,
          installationId: event.installationId,
          payload: JSON.stringify(event.payload),
        })
        .onConflictDoNothing({ target: [gitHubEvents.workspaceId, gitHubEvents.deliveryId] })
        .returning({ deliveryId: gitHubEvents.deliveryId });
      return inserted.length > 0 ? 'recorded' : 'recorded-before';
    },
  };
}
