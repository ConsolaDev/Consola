import { GITHUB_TOKEN_PURPOSES } from '../../domain/gitHubTokens.js';
import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** The contract's list as SQL string literals. Its values are the contract's own, never input. */
const listed = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', '));

/**
 * Every installation token minted from Consola's GitHub App (14.3), one row per token: which
 * workspace it was for, why, the repositories and permissions it was narrowed to, when it was
 * minted and when it expires. The token itself is never kept. The repositories are their ids on
 * GitHub, never their names, which are the company's information (`AGENTS.md`, "What is always
 * global"). A row is written before its token is handed out, so every token handed out has one.
 *
 * Consola's own table, written by hand. There is no foreign key: a record outlives what it speaks
 * of (an installation disconnected, a workspace deleted).
 */
export const githubTokenMint = pgTable(
  'github_token_mint',
  {
    /** In the order the mints were recorded. */
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    /** The workspace the token was minted for. */
    organizationId: text('organization_id').notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    /** One of the contract's `GITHUB_TOKEN_PURPOSES`. */
    purpose: text('purpose').notNull(),
    /** A JSON list of GitHub repository ids, in ascending order. */
    repositoryIds: jsonb('repository_ids').$type<number[]>().notNull(),
    /** A JSON object of the permissions GitHub granted, by GitHub's names. */
    permissions: jsonb('permissions').$type<Record<string, string>>().notNull(),
    mintedAt: timestamp('minted_at').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (table) => [
    index('github_token_mint_organization_idx').on(table.organizationId, table.mintedAt),
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
