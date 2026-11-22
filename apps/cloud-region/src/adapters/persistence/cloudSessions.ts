import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { CloudSessionStore, Ids } from '../../application/ports.js';
import { type CloudSession, LIVE_STATUSES } from '../../domain/cloudSession.js';
import type { Database } from './database.js';
import { cloudSessions } from './tables.js';

type Row = typeof cloudSessions.$inferSelect;

// The columns are text; only this adapter wrote them, and only values the domain names.
const toSession = (row: Row): CloudSession => ({
  ...row,
  repository: row.repository,
  harness: row.harness as CloudSession['harness'],
});

/** The cell's cloud sessions on one Drizzle database. */
export function createCloudSessionStore(db: Database): CloudSessionStore {
  return {
    async insert(session) {
      await db.insert(cloudSessions).values(session);
    },
    async find(sessionId) {
      const [row] = await db.select().from(cloudSessions).where(eq(cloudSessions.id, sessionId));
      return row ? toSession(row) : null;
    },
    async findOwn(workspaceId, personId, sessionId) {
      const [row] = await db
        .select()
        .from(cloudSessions)
        .where(
          and(
            eq(cloudSessions.id, sessionId),
            eq(cloudSessions.workspaceId, workspaceId),
            eq(cloudSessions.personId, personId),
          ),
        );
      return row ? toSession(row) : null;
    },
    async listOwn(workspaceId, personId) {
      const rows = await db
        .select()
        .from(cloudSessions)
        .where(
          and(eq(cloudSessions.workspaceId, workspaceId), eq(cloudSessions.personId, personId)),
        )
        .orderBy(desc(cloudSessions.createdAt), desc(cloudSessions.id));
      return rows.map(toSession);
    },
    async listLive({ workspaceId, runnerId }) {
      const rows = await db
        .select()
        .from(cloudSessions)
        .where(
          and(
            eq(cloudSessions.workspaceId, workspaceId),
            eq(cloudSessions.runnerId, runnerId),
            inArray(cloudSessions.status, [...LIVE_STATUSES]),
          ),
        );
      return rows.map(toSession);
    },
    async update(sessionId, expected, changes) {
      const changed = await db
        .update(cloudSessions)
        .set(changes)
        .where(and(eq(cloudSessions.id, sessionId), eq(cloudSessions.status, expected)))
        .returning({ id: cloudSessions.id });
      return changed.length === 1;
    },
  };
}

/** Unguessable ids from the machine's random source. */
export const randomIds: Ids = { newId: () => randomUUID() };
