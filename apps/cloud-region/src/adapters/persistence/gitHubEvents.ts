import { readGitHubEventFacts } from '@consola/runner-protocol';
import { and, count, desc, eq, gt, sql } from 'drizzle-orm';
import type { GitHubEventStore } from '../../application/ports.js';
import type { HeldEvent } from '../../domain/gitHubEvent.js';
import type { Database } from './database.js';
import { gitHubEvents, workspaces } from './tables.js';

/**
 * GitHub's events in the `github_event` table, each for its workspace. `record` holds the
 * workspace's copy row while it writes (`for key share`), and inserts the event unless one with
 * its delivery id is there already, so the same delivery arriving twice at once is recorded once,
 * and handed to a runner once. An event held for the runner stays `held` until the runner
 * acknowledges it, a compare-and-set from `held`.
 */
export function createGitHubEventStore(db: Database): GitHubEventStore {
  return {
    record(event, { handOver, repository }) {
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
            repositoryId: repository?.id ?? null,
            repository: repository?.fullName ?? null,
            runnerState:
              handOver === null ? null : handOver.kind === 'held' ? 'held' : 'not-for-runners',
            runnerFacts: handOver?.kind === 'held' ? handOver.facts : null,
          })
          .onConflictDoNothing()
          .returning({ deliveryId: gitHubEvents.deliveryId });
        return inserted.length > 0 ? 'recorded' : 'recorded-before';
      });
    },

    async acknowledge(workspaceId, deliveryId) {
      const changed = await db
        .update(gitHubEvents)
        .set({ runnerState: 'acknowledged' })
        .where(
          and(
            eq(gitHubEvents.workspaceId, workspaceId),
            eq(gitHubEvents.deliveryId, deliveryId),
            eq(gitHubEvents.runnerState, 'held'),
          ),
        )
        .returning({ deliveryId: gitHubEvents.deliveryId });
      return changed.length > 0 ? 'acknowledged' : 'not-held';
    },

    async held(workspaceId, sinceSeconds, limit) {
      const isHeld = and(
        eq(gitHubEvents.workspaceId, workspaceId),
        eq(gitHubEvents.runnerState, 'held'),
      );
      const rows = await db
        .select({ deliveryId: gitHubEvents.deliveryId, facts: gitHubEvents.runnerFacts })
        .from(gitHubEvents)
        .where(and(isHeld, gt(gitHubEvents.receivedAt, new Date(sinceSeconds * 1000))))
        .orderBy(desc(gitHubEvents.receivedAt), desc(gitHubEvents.deliveryId))
        .limit(limit);
      const [all] = await db.select({ held: count() }).from(gitHubEvents).where(isHeld);
      // Read back as the protocol reads them, never taken on trust from the column's type.
      const events: HeldEvent[] = [];
      const unreadable: string[] = [];
      for (const row of rows.reverse()) {
        const facts = readGitHubEventFacts(row.facts);
        if (facts.ok) events.push({ deliveryId: row.deliveryId, facts: facts.value });
        else unreadable.push(row.deliveryId);
      }
      return { events, unreadable, left: Number(all?.held ?? 0) - rows.length };
    },

    async repositoryOf(workspaceId, repository) {
      const [row] = await db
        .select({
          installationId: gitHubEvents.installationId,
          repositoryId: gitHubEvents.repositoryId,
        })
        .from(gitHubEvents)
        .where(
          and(
            eq(gitHubEvents.workspaceId, workspaceId),
            sql`lower(${gitHubEvents.repository}) = lower(${repository})`,
          ),
        )
        .orderBy(desc(gitHubEvents.receivedAt))
        .limit(1);
      return row && row.repositoryId !== null
        ? { installationId: row.installationId, repositoryId: row.repositoryId }
        : null;
    },
  };
}
