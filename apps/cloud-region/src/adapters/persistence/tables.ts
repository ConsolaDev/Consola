// The cell's tables, each exported from here so `drizzle-kit generate` finds it
// (drizzle.config.ts).
//
// Every table carries a not-null `workspace_id` (the workspace's id in cloud-global), and a
// person is a column holding their global id, never a copy of their account. `schema.test.ts`
// checks both.

import type { WorkspaceRole } from '@consola/cloud-contract';
import type { CellFailureCode, CloudSessionStatus } from '../../domain/cloudSession.js';
import { bigint, index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

/**
 * The cell's copy of each workspace in its region, kept from cloud-global's outbox messages: a row
 * once the workspace's `workspace.created` is applied. `last_applied_sequence` is the sequence of
 * the last of its messages the cell applied, which every later message is placed against.
 * Nothing else about the workspace (its name, its slug) is here: the cell needs only its id.
 */
export const workspaces = pgTable('workspace', {
  workspaceId: text('workspace_id').primaryKey(),
  // The contract's sequences are whole numbers JavaScript keeps exactly, past an integer's range.
  lastAppliedSequence: bigint('last_applied_sequence', { mode: 'number' }).notNull(),
});

/**
 * Who is a member of each workspace, and with which role, from the same messages. A person is
 * their global id and their role, and nothing more: no email, no name.
 */
export const workspaceMembers = pgTable(
  'workspace_member',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.workspaceId),
    personId: text('person_id').notNull(),
    role: text('role').$type<WorkspaceRole>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.personId] })],
);

/**
 * A person's cloud session. No foreign key to `workspace`: a session is the workspace's whatever
 * the outbox has delivered yet. `error` is a message a runner reported and `error_code` a code the
 * cell decided (`CELL_FAILURE_CODES`); a failure has one of them.
 */
export const cloudSessions = pgTable(
  'cloud_session',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    personId: text('person_id').notNull(),
    repository: text('repository').notNull(),
    harness: text('harness').notNull(),
    status: text('status').$type<CloudSessionStatus>().notNull(),
    title: text('title'),
    hostUrl: text('host_url'),
    error: text('error'),
    errorCode: text('error_code').$type<CellFailureCode>(),
    runnerId: text('runner_id').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    endedAt: bigint('ended_at', { mode: 'number' }),
  },
  (table) => [index('cloud_session_owner').on(table.workspaceId, table.personId, table.createdAt)],
);
