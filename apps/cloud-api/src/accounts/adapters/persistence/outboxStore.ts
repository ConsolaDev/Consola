import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { OutboxStore, UndeliveredMessage } from '../../application/ports.js';
import type { Database } from './database.js';
import { schema } from './schema.js';

const { outboxMessage } = schema;

const undelivered = {
  organizationId: outboxMessage.organizationId,
  sequence: outboxMessage.sequence,
  region: outboxMessage.region,
  changeType: outboxMessage.changeType,
  personId: outboxMessage.personId,
  role: outboxMessage.role,
  attempts: outboxMessage.attempts,
  nextAttemptAt: outboxMessage.nextAttemptAt,
};

type Row = {
  organizationId: string;
  sequence: number;
  region: string;
  changeType: string;
  personId: string | null;
  role: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
};

/**
 * A row as the message the contract describes, a change's empty fields left out, unchecked: the
 * use case reads it with the contract's reader before anything is signed.
 */
function undeliveredOf(row: Row): UndeliveredMessage {
  const change: Record<string, string> = { type: row.changeType };
  if (row.personId !== null) change.personId = row.personId;
  if (row.role !== null) change.role = row.role;
  return {
    key: { workspaceId: row.organizationId, sequence: row.sequence },
    stored: {
      workspaceId: row.organizationId,
      region: row.region,
      sequence: row.sequence,
      change,
    },
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
  };
}

const keyOf = (key: { workspaceId: string; sequence: number }) =>
  and(
    eq(outboxMessage.organizationId, key.workspaceId),
    eq(outboxMessage.sequence, key.sequence),
    // Never a second confirmation, or a failure recorded over one.
    isNull(outboxMessage.deliveredAt),
  );

/**
 * The outbox's deliveries, on `outbox_message`. Messages are written only with their change
 * (`writeWorkspaceChange`); this reads each workspace's first undelivered one and records how
 * each delivery went. It keeps a message once delivered, with when and after how many attempts.
 */
export function createOutboxStore(db: Database): OutboxStore {
  return {
    async firstUndelivered() {
      const rows = await db
        .selectDistinctOn([outboxMessage.organizationId], undelivered)
        .from(outboxMessage)
        .where(isNull(outboxMessage.deliveredAt))
        .orderBy(asc(outboxMessage.organizationId), asc(outboxMessage.sequence));
      return rows.map(undeliveredOf);
    },

    async firstUndeliveredOf(workspaceId) {
      const [row] = await db
        .select(undelivered)
        .from(outboxMessage)
        .where(
          and(eq(outboxMessage.organizationId, workspaceId), isNull(outboxMessage.deliveredAt)),
        )
        .orderBy(asc(outboxMessage.sequence))
        .limit(1);
      return row ? undeliveredOf(row) : null;
    },

    async recordDelivered(key, at) {
      await db
        .update(outboxMessage)
        .set({
          deliveredAt: at,
          lastAttemptAt: at,
          attempts: sql`${outboxMessage.attempts} + 1`,
          nextAttemptAt: null,
        })
        .where(keyOf(key));
    },

    async recordFailed(key, failure) {
      await db
        .update(outboxMessage)
        .set({
          lastAttemptAt: failure.at,
          lastError: failure.error,
          attempts: sql`${outboxMessage.attempts} + 1`,
          nextAttemptAt: failure.nextAttemptAt,
        })
        .where(keyOf(key));
    },
  };
}
