import { REGIONS, WORKSPACE_ROLES } from '@consola/cloud-contract';
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/** The contract's list as SQL string literals. Its values are the contract's own, never input. */
const listed = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', '));

/**
 * The outbox: every change a workspace's cell must hear about, one row per message, written in
 * the same transaction as the change itself (`writeWorkspaceChange`), then delivered in sequence
 * order until the cell confirms it. Consola's own table, not Better Auth's, so it is written by
 * hand and never by `auth:generate`.
 *
 * A row holds the message (`organization_id`, `region`, `sequence` and the change, which is ids
 * and a role only) and its delivery so far. The checks hold every row to the shape the
 * contract's reader takes, so no row can carry anything else about a person. There is no foreign
 * key: a message outlives what it speaks of (a member removed, a person's account deleted), and
 * its cell must still hear it.
 */
export const outboxMessage = pgTable(
  'outbox_message',
  {
    /** The workspace's id, the message's `workspaceId`. */
    organizationId: text('organization_id').notNull(),
    /** The message's place among its workspace's messages, from 1, with no gaps. */
    sequence: integer('sequence').notNull(),
    /** The workspace's region when the message was written, which never changes. */
    region: text('region').notNull(),
    /** The change's `type`, one of the contract's `WORKSPACE_CHANGE_TYPES`. */
    changeType: text('change_type').notNull(),
    /** The person a member change is about (their global id); null for `workspace.created`. */
    personId: text('person_id'),
    /** The role a member was added with or changed to; null for any other change. */
    role: text('role'),
    createdAt: timestamp('created_at').notNull(),
    /** How many times delivery was tried, the one that succeeded included. */
    attempts: integer('attempts').default(0).notNull(),
    lastAttemptAt: timestamp('last_attempt_at'),
    /** Why the last failed delivery failed: a status, or what the cell's answer said. */
    lastError: text('last_error'),
    /** When the next delivery is due; null when none has failed, so it is due at once. */
    nextAttemptAt: timestamp('next_attempt_at'),
    /** When the cell confirmed it; null until then. */
    deliveredAt: timestamp('delivered_at'),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.sequence] }),
    // Each workspace's first undelivered message, which is all the worker ever reads.
    index('outbox_message_undelivered_idx')
      .on(table.organizationId, table.sequence)
      .where(sql`${table.deliveredAt} is null`),
    check('outbox_message_region_check', sql`${table.region} in (${listed(REGIONS)})`),
    // The contract's reader, as a check: `workspace.created` is a workspace's first message and
    // carries nothing but its type; every other change comes after it and names a person, with a
    // role exactly when the change gives one.
    check(
      'outbox_message_change_check',
      sql`(${table.changeType} = 'workspace.created' and ${table.sequence} = 1 and ${table.personId} is null and ${table.role} is null)
        or (${table.changeType} in ('member.added', 'member.role-changed') and ${table.sequence} > 1 and ${table.personId} is not null and ${table.role} in (${listed(WORKSPACE_ROLES)}))
        or (${table.changeType} = 'member.removed' and ${table.sequence} > 1 and ${table.personId} is not null and ${table.role} is null)`,
    ),
  ],
);
