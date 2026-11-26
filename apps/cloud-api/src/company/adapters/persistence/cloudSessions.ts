import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { CloudSessionChanges, CloudSessionStore, Ids } from '../../application/ports.js';
import { LIVE_STATUSES } from '../../domain/cloudSession.js';
import type { CloudSession } from '../../domain/cloudSession.js';
import type { Database } from './database.js';
import { cloudSessions } from './tables.js';

type Row = typeof cloudSessions.$inferSelect;
type Insert = typeof cloudSessions.$inferInsert;

/** JSON as the text columns hold it, or null. */
const readJson = <T>(text: string | null): T | null =>
  text === null ? null : (JSON.parse(text) as T);
const writeJson = (value: unknown): string | null =>
  value === null ? null : JSON.stringify(value);

// The columns are text; only this adapter wrote them, and only values the domain names.
const toSession = (row: Row): CloudSession => ({
  ...row,
  repository: row.repository,
  harness: row.harness as CloudSession['harness'],
  origin: readJson<CloudSession['origin']>(row.origin),
  agentRun: readJson<CloudSession['agentRun']>(row.agentRun),
});

const toRow = (session: CloudSession): Insert => ({
  ...session,
  origin: writeJson(session.origin),
  agentRun: writeJson(session.agentRun),
});

function toChanges(changes: CloudSessionChanges): Partial<Insert> {
  const { agentRun, ...rest } = changes;
  return agentRun === undefined ? rest : { ...rest, agentRun: writeJson(agentRun) };
}

/**
 * What a person may open in a workspace (`isSeenBy`): their own sessions, and its agent runs, each
 * the conversation of one of its runs.
 */
const seenBy = (workspaceId: string, personId: string) =>
  and(
    eq(cloudSessions.workspaceId, workspaceId),
    or(eq(cloudSessions.personId, personId), isNotNull(cloudSessions.origin)),
  );

/** The cell's cloud sessions on one Drizzle database. */
export function createCloudSessionStore(db: Database): CloudSessionStore {
  return {
    async insert(session) {
      await db.insert(cloudSessions).values(toRow(session));
    },
    async find(sessionId) {
      const [row] = await db.select().from(cloudSessions).where(eq(cloudSessions.id, sessionId));
      return row ? toSession(row) : null;
    },
    async findSeen(workspaceId, personId, sessionId) {
      const [row] = await db
        .select()
        .from(cloudSessions)
        .where(and(eq(cloudSessions.id, sessionId), seenBy(workspaceId, personId)));
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
        .set(toChanges(changes))
        .where(and(eq(cloudSessions.id, sessionId), eq(cloudSessions.status, expected)))
        .returning({ id: cloudSessions.id });
      return changed.length === 1;
    },
  };
}

/** Unguessable ids from the machine's random source. */
export const randomIds: Ids = { newId: () => randomUUID() };
