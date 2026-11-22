// The cell's tables, each exported from here so `drizzle-kit generate` finds it
// (drizzle.config.ts).
//
// Every table carries a not-null `workspace_id` (the workspace's id in cloud-global), and a
// person is a column holding their global id, never a copy of their account. `schema.test.ts`
// checks both.

import type { WorkspaceRole } from '@consola/cloud-contract';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

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
 * A workspace's teams (`domain/team.ts`). Names are unique in a workspace whatever their case,
 * and each workspace has exactly one first team (`is_first`), which the cell makes as it applies
 * the workspace's `workspace.created` and never deletes. The cell gives a team its id.
 */
export const teams = pgTable(
  'team',
  {
    teamId: text('team_id').primaryKey().default(sql`gen_random_uuid()::text`),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.workspaceId),
    name: text('name').notNull(),
    isFirst: boolean('is_first').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // What a team member's row points at, so a member is always in a team of their workspace.
    unique('team_workspace_id_team_id_unique').on(table.workspaceId, table.teamId),
    uniqueIndex('team_name_unique').on(table.workspaceId, sql`lower(${table.name})`),
    uniqueIndex('team_first_unique').on(table.workspaceId).where(sql`${table.isFirst}`),
  ],
);

/**
 * Who is in each team, by global id. A row points at its workspace's copy of the member, so only
 * a member of the workspace can be in one of its teams, and a member who leaves the workspace
 * leaves every team in the same transaction (the copy's row goes, and these go with it). Deleting
 * a team takes its rows too.
 */
export const teamMembers = pgTable(
  'team_member',
  {
    workspaceId: text('workspace_id').notNull(),
    teamId: text('team_id').notNull(),
    personId: text('person_id').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.personId] }),
    // Named here, since the names drizzle makes up are past Postgres's 63 characters.
    foreignKey({
      name: 'team_member_team_fk',
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [teams.workspaceId, teams.teamId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'team_member_workspace_member_fk',
      columns: [table.workspaceId, table.personId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.personId],
    }).onDelete('cascade'),
  ],
);
