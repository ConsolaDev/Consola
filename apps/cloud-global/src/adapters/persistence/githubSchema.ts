import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { organization, user } from './auth-schema.js';

// Consola's own tables, beside the ones Better Auth generates (`auth-schema.ts`). Each is on the
// always-global list (`AGENTS.md`, "What is always global"), which `alwaysGlobal.test.ts` pins.

/**
 * The installations of Consola's GitHub App that workspaces hold. The installation's id is the
 * key, so no installation belongs to two workspaces. The account is the one GitHub named when the
 * workspace connected it. The repositories are not kept: GitHub is asked for them each time.
 */
export const githubInstallation = pgTable(
  'github_installation',
  {
    installationId: bigint('installation_id', { mode: 'number' }).primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    accountId: bigint('account_id', { mode: 'number' }).notNull(),
    accountLogin: text('account_login').notNull(),
    accountType: text('account_type').notNull(),
    // Who connected it. Kept when they leave the workspace; empty once their account is deleted.
    connectedBy: text('connected_by').references(() => user.id, { onDelete: 'set null' }),
    connectedAt: timestamp('connected_at').notNull(),
  },
  (table) => [index('github_installation_organizationId_idx').on(table.organizationId)],
);
