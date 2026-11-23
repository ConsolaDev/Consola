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
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { CellFailureCode, CloudSessionStatus } from '../../domain/cloudSession.js';
import type { FactorySource } from '../../domain/factory.js';

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

/**
 * A workspace's factories (`domain/factory.ts`), each owned by one of its teams: the team is
 * pointed at through both ids, so it is always a team of the factory's own workspace, and a team
 * that owns a factory cannot be deleted. Names are unique in a workspace whatever their case.
 * `latest_version` is the number of its latest version, which a save moves by a compare-and-set.
 * The cell gives a factory its id. `source` says where its files come from: `stored`, here.
 */
export const factories = pgTable(
  'factory',
  {
    factoryId: text('factory_id').primaryKey().default(sql`gen_random_uuid()::text`),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.workspaceId),
    teamId: text('team_id').notNull(),
    name: text('name').notNull(),
    source: text('source').$type<FactorySource['kind']>().notNull().default('stored'),
    latestVersion: integer('latest_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // What a version's row points at, so a version is always of a factory of its workspace.
    unique('factory_workspace_id_factory_id_unique').on(table.workspaceId, table.factoryId),
    uniqueIndex('factory_name_unique').on(table.workspaceId, sql`lower(${table.name})`),
    // No action on delete: a team that owns a factory stays.
    foreignKey({
      name: 'factory_team_fk',
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [teams.workspaceId, teams.teamId],
    }),
  ],
);

/**
 * Each version of a factory's files: who saved it, by global id, and when. Versions are numbered
 * from 1, the blank version a factory is made with, and are never changed once saved.
 */
export const factoryVersions = pgTable(
  'factory_version',
  {
    workspaceId: text('workspace_id').notNull(),
    factoryId: text('factory_id').notNull(),
    version: integer('version').notNull(),
    savedBy: text('saved_by_person_id').notNull(),
    savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.factoryId, table.version] }),
    foreignKey({
      name: 'factory_version_factory_fk',
      columns: [table.workspaceId, table.factoryId],
      foreignColumns: [factories.workspaceId, factories.factoryId],
    }).onDelete('cascade'),
  ],
);

/** The files of each version, a row each: its path inside the factory's folder and its text. */
export const factoryFiles = pgTable(
  'factory_file',
  {
    workspaceId: text('workspace_id').notNull(),
    factoryId: text('factory_id').notNull(),
    version: integer('version').notNull(),
    path: text('path').notNull(),
    content: text('content').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.factoryId, table.version, table.path] }),
    foreignKey({
      name: 'factory_file_version_fk',
      columns: [table.workspaceId, table.factoryId, table.version],
      foreignColumns: [
        factoryVersions.workspaceId,
        factoryVersions.factoryId,
        factoryVersions.version,
      ],
    }).onDelete('cascade'),
  ],
);

/**
 * The GitHub events `cloud-global` passed on for each workspace (14.2), kept here because what
 * happens in a company's repositories is the company's. One row per GitHub delivery, keyed by
 * the workspace and GitHub's id of the delivery, which GitHub keeps when it sends one again, so
 * an event is recorded once. The payload is GitHub's JSON as text: `json` and `jsonb` both
 * refuse a `\u0000` escape, which a pull request's body or a comment can hold. The workspace's
 * runners and triggers read them later (epics 21 and 39).
 */
export const gitHubEvents = pgTable(
  'github_event',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.workspaceId),
    deliveryId: text('delivery_id').notNull(),
    event: text('event').notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    payload: text('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.deliveryId] }),
    index('github_event_received_idx').on(table.workspaceId, table.receivedAt),
  ],
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
