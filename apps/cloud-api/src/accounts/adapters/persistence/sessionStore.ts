import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { SessionStore } from '../../application/ports.js';
import type { Database } from './database.js';
import { schema } from './schema.js';

/**
 * The active workspace on Better Auth's `session` rows (`active_organization_id`), written here
 * rather than through Better Auth. That is right only while Better Auth reads every session from
 * the database: with its cookie cache on, a session would keep the workspace it had until its
 * cookie expired.
 */
export function createSessionStore(db: Database): SessionStore {
  return {
    async setActiveWorkspace(ids) {
      await db
        .update(schema.session)
        .set({ activeOrganizationId: ids.workspaceId, updatedAt: new Date() })
        .where(eq(schema.session.id, ids.sessionId));
    },

    async lastActiveWorkspace(userId) {
      const [row] = await db
        .select({ workspaceId: schema.session.activeOrganizationId })
        .from(schema.session)
        .where(
          and(eq(schema.session.userId, userId), isNotNull(schema.session.activeOrganizationId)),
        )
        .orderBy(desc(schema.session.updatedAt), desc(schema.session.createdAt))
        .limit(1);
      return row?.workspaceId ?? null;
    },
  };
}
