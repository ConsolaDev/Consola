// Slack's tables in the company part (CON-144): each factory's Slack app, the Slack accounts
// people linked, the one-time links Consola sent, the events Slack sent and the threads requests
// were started from. Each carries its workspace's id. A person is their id and no more, with no
// foreign key, and no Slack name or email is kept. Every secret is sealed text
// (`SecretSealer`), never the secret itself.

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { Sealed, SlackPosted } from '../../domain/slack.js';
import { cloudSessions, factories } from './tables.js';

const at = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

/**
 * A factory's Slack app, one per factory: its client ID, the bot's handle, and its secrets,
 * sealed. The install's columns (the app, the Slack workspace and the bot it made there, the bot
 * token, who added it and when) are set together by "Add to Slack", and are null until then. An
 * app id is held by one factory at most, so one Slack app never answers for two. The row goes
 * with its factory.
 */
export const slackApps = pgTable(
  'slack_app',
  {
    workspaceId: text('workspace_id').notNull(),
    factoryId: text('factory_id').primaryKey(),
    clientId: text('client_id').notNull(),
    clientSecret: text('client_secret').$type<Sealed>().notNull(),
    signingSecret: text('signing_secret').$type<Sealed>().notNull(),
    handle: text('handle').notNull(),
    configuredBy: text('configured_by').notNull(),
    configuredAt: at('configured_at').notNull(),
    appId: text('app_id'),
    teamId: text('team_id'),
    teamName: text('team_name'),
    botUserId: text('bot_user_id'),
    botToken: text('bot_token').$type<Sealed>(),
    installedBy: text('installed_by'),
    installedAt: at('installed_at'),
    needsReinstall: boolean('needs_reinstall').notNull().default(false),
  },
  (table) => [
    foreignKey({
      name: 'slack_app_factory_fk',
      columns: [table.workspaceId, table.factoryId],
      foreignColumns: [factories.workspaceId, factories.factoryId],
    }).onDelete('cascade'),
    index('slack_app_workspace_idx').on(table.workspaceId),
    uniqueIndex('slack_app_app_unique').on(table.appId).where(sql`${table.appId} is not null`),
    check(
      'slack_app_install_check',
      sql`(${table.appId} is null) = (${table.botToken} is null) and (${table.appId} is null) = (${table.teamId} is null) and (${table.appId} is null) = (${table.teamName} is null) and (${table.appId} is null) = (${table.botUserId} is null) and (${table.appId} is null) = (${table.installedBy} is null) and (${table.appId} is null) = (${table.installedAt} is null)`,
    ),
    check(
      'slack_app_reinstall_check',
      sql`not ${table.needsReinstall} or ${table.appId} is not null`,
    ),
  ],
);

/**
 * The Slack accounts people linked to their Consola account, per workspace: the Slack workspace
 * (team) and user, and the person's id. One person per Slack user in a workspace.
 */
export const slackPersonLinks = pgTable(
  'slack_person_link',
  {
    linkId: text('link_id').primaryKey().default(sql`gen_random_uuid()::text`),
    workspaceId: text('workspace_id').notNull(),
    slackTeamId: text('slack_team_id').notNull(),
    slackUserId: text('slack_user_id').notNull(),
    personId: text('person_id').notNull(),
    linkedAt: at('linked_at').notNull(),
  },
  (table) => [
    unique('slack_person_link_user_unique').on(
      table.workspaceId,
      table.slackTeamId,
      table.slackUserId,
    ),
    index('slack_person_link_person_idx').on(table.workspaceId, table.personId),
  ],
);

/**
 * The one-time links Consola sent Slack users who wrote to a factory's bot before linking. The
 * token is kept only as its hash (SHA-256, hex). A link works once (`used_at`), until it expires.
 */
export const slackLinkRequests = pgTable(
  'slack_link_request',
  {
    tokenHash: text('token_hash').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    factoryId: text('factory_id').notNull(),
    slackTeamId: text('slack_team_id').notNull(),
    slackUserId: text('slack_user_id').notNull(),
    channelId: text('channel_id').notNull(),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    usedAt: at('used_at'),
  },
  (table) => [
    foreignKey({
      name: 'slack_link_request_factory_fk',
      columns: [table.workspaceId, table.factoryId],
      foreignColumns: [factories.workspaceId, factories.factoryId],
    }).onDelete('cascade'),
    index('slack_link_request_factory_idx').on(table.workspaceId, table.factoryId),
  ],
);

/**
 * The events Slack sent each factory's app, by Slack's `event_id`, so an event Slack sends again
 * changes nothing. Only the ids are kept, never what the event said.
 */
export const slackEvents = pgTable(
  'slack_event',
  {
    workspaceId: text('workspace_id').notNull(),
    factoryId: text('factory_id').notNull(),
    eventId: text('event_id').notNull(),
    receivedAt: at('received_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.factoryId, table.eventId] }),
    foreignKey({
      name: 'slack_event_factory_fk',
      columns: [table.workspaceId, table.factoryId],
      foreignColumns: [factories.workspaceId, factories.factoryId],
    }).onDelete('cascade'),
    index('slack_event_received_idx').on(table.workspaceId, table.receivedAt),
  ],
);

/**
 * The Slack thread each request from Slack was started from, one per cloud session: where
 * Consola answers, who started it (the linked person's id), and what Consola last posted there,
 * which a compare-and-set moves so each state is posted once.
 */
export const slackRequests = pgTable(
  'slack_request',
  {
    workspaceId: text('workspace_id').notNull(),
    sessionId: text('session_id').primaryKey(),
    factoryId: text('factory_id').notNull(),
    slackTeamId: text('slack_team_id').notNull(),
    channelId: text('channel_id').notNull(),
    threadTs: text('thread_ts').notNull(),
    messageTs: text('message_ts').notNull(),
    startedBy: text('started_by').notNull(),
    posted: text('posted').$type<SlackPosted>(),
    createdAt: at('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'slack_request_session_fk',
      columns: [table.sessionId],
      foreignColumns: [cloudSessions.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'slack_request_factory_fk',
      columns: [table.workspaceId, table.factoryId],
      foreignColumns: [factories.workspaceId, factories.factoryId],
    }).onDelete('cascade'),
    index('slack_request_thread_idx').on(table.factoryId, table.channelId, table.threadTs),
  ],
);
