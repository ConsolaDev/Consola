import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { GITHUB_TOKEN_PURPOSES } from '../../domain/gitHubTokens.js';

// GitHub's tables in the company part: the installations workspaces hold, the tokens minted for
// them and the events GitHub sent through them. Each carries its workspace's id, and none has a
// foreign key out of these three: a workspace and a person are their ids here and no more, so
// nothing here reads, or waits on, an account table.

/** The domain's list as SQL string literals. Its values are the domain's own, never input. */
const listed = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', '));

/**
 * The installations of Consola's GitHub App that workspaces hold. The installation's id is the
 * key, so no installation belongs to two workspaces. The account is the one GitHub named when the
 * workspace connected it. The repositories are not kept: GitHub is asked for them each time.
 */
export const githubInstallation = pgTable(
  'github_installation',
  {
    installationId: bigint('installation_id', { mode: 'number' }).primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    accountId: bigint('account_id', { mode: 'number' }).notNull(),
    accountLogin: text('account_login').notNull(),
    accountType: text('account_type').notNull(),
    // Who connected it, by their id: kept when they leave the workspace, or their account goes.
    connectedBy: text('connected_by').notNull(),
    connectedAt: timestamp('connected_at').notNull(),
  },
  (table) => [index('github_installation_workspace_idx').on(table.workspaceId)],
);

/**
 * Every installation token minted from Consola's GitHub App (14.3), one row per token: which
 * workspace it was for, why, the repositories and permissions it was narrowed to, when it was
 * minted and when it expires. The token itself is never kept. The repositories are their ids on
 * GitHub, never their names. A row is written before its token is handed out, so every token
 * handed out has one. A record outlives what it speaks of (an installation disconnected, a
 * workspace deleted).
 */
export const githubTokenMint = pgTable(
  'github_token_mint',
  {
    /** In the order the mints were recorded. */
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    /** The workspace the token was minted for. */
    workspaceId: text('workspace_id').notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    /** One of the domain's `GITHUB_TOKEN_PURPOSES`. */
    purpose: text('purpose').notNull(),
    /** A JSON list of GitHub repository ids, in ascending order. */
    repositoryIds: jsonb('repository_ids').$type<number[]>().notNull(),
    /** A JSON object of the permissions GitHub granted, by GitHub's names. */
    permissions: jsonb('permissions').$type<Record<string, string>>().notNull(),
    mintedAt: timestamp('minted_at').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (table) => [
    index('github_token_mint_workspace_idx').on(table.workspaceId, table.mintedAt),
    check(
      'github_token_mint_purpose_check',
      sql`${table.purpose} in (${listed(GITHUB_TOKEN_PURPOSES)})`,
    ),
    check(
      'github_token_mint_repositories_check',
      sql`jsonb_typeof(${table.repositoryIds}) = 'array' and jsonb_array_length(${table.repositoryIds}) > 0`,
    ),
    check(
      'github_token_mint_permissions_check',
      sql`jsonb_typeof(${table.permissions}) = 'object'`,
    ),
  ],
);

/**
 * The GitHub events each workspace received (14.2), kept because what happens in a company's
 * repositories is the company's. One row per GitHub delivery, keyed by the workspace and GitHub's
 * id of the delivery, which GitHub keeps when it sends one again, so an event is recorded once.
 * The payload is GitHub's JSON as text: `json` and `jsonb` both refuse a `\u0000` escape, which a
 * pull request's body or a comment can hold. The workspace's runners and triggers read them later
 * (epics 21 and 39).
 */
export const gitHubEvents = pgTable(
  'github_event',
  {
    workspaceId: text('workspace_id').notNull(),
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
