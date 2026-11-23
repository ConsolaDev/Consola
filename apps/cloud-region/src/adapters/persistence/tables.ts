// The cell's tables, each exported from here so `drizzle-kit generate` finds it
// (drizzle.config.ts).
//
// Every table carries a not-null `workspace_id` (the workspace's id in cloud-global), and a
// person is a column holding their global id, never a copy of their account. `schema.test.ts`
// checks both.

import type { WorkspaceRole } from '@consola/cloud-contract';
import { type SQLWrapper, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { FactorySource } from '../../domain/factory.js';
import { APPROVAL_DECISIONS, type ApprovalDecision } from '../../domain/runApproval.js';
import {
  PHASES,
  type Phase,
  RUN_KINDS,
  RUN_STATUSES,
  RUN_TRIGGERS,
  type RequestFacts,
  type RunItem,
  type RunKind,
  type RunStatus,
  type RunTrigger,
  type StepRecord,
  WAITING_ON,
  type WaitingOn,
} from '../../domain/run.js';

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

/** A run's time, to the millisecond, as runners write it: a cursor holding one finds it again. */
const runTime = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

/** `column in (…)`, for a check: the words are the domain's own constants, written as literals. */
const oneOf = (column: SQLWrapper, words: readonly string[]) =>
  sql`${column} in (${sql.raw(words.map((word) => `'${word}'`).join(', '))})`;

/**
 * A workspace's runs (`domain/run.ts`), each as its runner last recorded it, keyed by the
 * runner's id. A run points at the version of its factory it ran, so its factory and version are
 * always the workspace's own. A run a request started points at the request through the
 * request's factory too, so a child is always of its request's factory, and whoever sees the
 * child sees the request. `title` and `phase` are the cell's, stored when the run is recorded so
 * the list filters, searches and counts by them; a request's phase rolls up its children's. The
 * item, the steps and a request's facts are JSON; a request's text, which only its page reads, is
 * a column of its own. The checks hold the domain's rules on the row as a backstop to
 * `checkRun`.
 */
export const runs = pgTable(
  'run',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.workspaceId),
    runId: text('run_id').notNull(),
    factoryId: text('factory_id').notNull(),
    factoryVersion: integer('factory_version').notNull(),
    parentRunId: text('parent_run_id'),
    parentMove: integer('parent_move'),
    kind: text('kind').$type<RunKind>().notNull(),
    automation: text('automation'),
    title: text('title').notNull(),
    status: text('status').$type<RunStatus>().notNull(),
    waitingOn: text('waiting_on').$type<WaitingOn>(),
    phase: text('phase').$type<Phase>().notNull(),
    trigger: text('trigger').$type<RunTrigger>().notNull(),
    triggerDetail: text('trigger_detail'),
    startedBy: text('started_by_person_id'),
    item: jsonb('item').$type<RunItem>(),
    runner: text('runner').notNull(),
    steps: jsonb('steps').$type<StepRecord[]>().notNull(),
    request: jsonb('request').$type<RequestFacts>(),
    requestText: text('request_text'),
    summary: text('summary'),
    error: text('error'),
    costUsd: doublePrecision('cost_usd'),
    createdAt: runTime('created_at').notNull(),
    startedAt: runTime('started_at'),
    finishedAt: runTime('finished_at'),
    updatedAt: runTime('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.runId] }),
    // What a child's row points at, so a child is always of its request's factory.
    unique('run_factory_run_unique').on(table.workspaceId, table.factoryId, table.runId),
    foreignKey({
      name: 'run_factory_version_fk',
      columns: [table.workspaceId, table.factoryId, table.factoryVersion],
      foreignColumns: [
        factoryVersions.workspaceId,
        factoryVersions.factoryId,
        factoryVersions.version,
      ],
    }),
    foreignKey({
      name: 'run_parent_fk',
      columns: [table.workspaceId, table.factoryId, table.parentRunId],
      foreignColumns: [table.workspaceId, table.factoryId, table.runId],
    }),
    // The list: a workspace's top-level runs, newest first.
    index('run_list_idx')
      .on(table.workspaceId, table.createdAt.desc(), table.runId.desc())
      .where(sql`${table.parentRunId} is null`),
    // A request's runs, in the order it started them.
    index('run_children_idx')
      .on(table.workspaceId, table.parentRunId, table.parentMove)
      .where(sql`${table.parentRunId} is not null`),
    check('run_kind_check', oneOf(table.kind, RUN_KINDS)),
    check('run_status_check', oneOf(table.status, RUN_STATUSES)),
    check('run_phase_check', oneOf(table.phase, PHASES)),
    check('run_trigger_check', oneOf(table.trigger, RUN_TRIGGERS)),
    check(
      'run_waiting_on_check',
      sql`(${table.status} = 'waiting') = (${table.waitingOn} is not null) and (${table.waitingOn} is null or ${oneOf(table.waitingOn, WAITING_ON)})`,
    ),
    check(
      'run_request_check',
      sql`(${table.kind} = 'request') = (${table.automation} is null) and (${table.kind} = 'request') = (${table.request} is not null) and (${table.kind} = 'request') = (${table.requestText} is not null)`,
    ),
    check(
      'run_parent_check',
      sql`(${table.parentRunId} is null) = (${table.parentMove} is null) and (${table.parentRunId} is null or ${table.kind} = 'automation')`,
    ),
  ],
);

/**
 * The answers people gave runs waiting for approval (`domain/runApproval.ts`): one per run and
 * factory version, the first given, by global id. The cell records an answer and never changes
 * the run for it: its runner acts on it. An answer goes with its run.
 */
export const runApprovals = pgTable(
  'run_approval',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.workspaceId),
    runId: text('run_id').notNull(),
    version: integer('version').notNull(),
    decision: text('decision').$type<ApprovalDecision>().notNull(),
    personId: text('person_id').notNull(),
    answeredAt: timestamp('answered_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.runId, table.version] }),
    foreignKey({
      name: 'run_approval_run_fk',
      columns: [table.workspaceId, table.runId],
      foreignColumns: [runs.workspaceId, runs.runId],
    }).onDelete('cascade'),
    check('run_approval_decision_check', oneOf(table.decision, APPROVAL_DECISIONS)),
  ],
);
