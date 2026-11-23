import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from './database.js';
import { schema } from './schema.js';

/**
 * The always-global list (`AGENTS.md`, "What is always global"), as the tables and columns that
 * hold it. Everything cloud-global stores must be here; anything else belongs in a regional cell.
 * Change the list in `AGENTS.md` first, then here.
 */
const ALWAYS_GLOBAL: Record<string, { holds: string; columns: string[] }> = {
  user: {
    holds: 'Accounts: email and name',
    columns: ['id', 'name', 'email', 'email_verified', 'image', 'created_at', 'updated_at'],
  },
  account: {
    holds: 'Accounts: sign-ins (the Google account a person signs in with)',
    columns: [
      'id',
      'account_id',
      'provider_id',
      'user_id',
      'access_token',
      'refresh_token',
      'id_token',
      'access_token_expires_at',
      'refresh_token_expires_at',
      'scope',
      'password',
      'created_at',
      'updated_at',
    ],
  },
  session: {
    holds: 'Accounts: sessions',
    columns: [
      'id',
      'expires_at',
      'token',
      'created_at',
      'updated_at',
      'ip_address',
      'user_agent',
      'user_id',
      'active_organization_id',
    ],
  },
  verification: {
    holds: 'Accounts: sign-ins in progress (OAuth state)',
    columns: ['id', 'identifier', 'value', 'expires_at', 'created_at', 'updated_at'],
  },
  organization: {
    holds: 'The workspace list: id, name, slug and region',
    columns: ['id', 'name', 'slug', 'logo', 'created_at', 'metadata', 'region'],
  },
  member: {
    holds: 'Membership: who is in which workspace, and their workspace-level role',
    columns: ['id', 'organization_id', 'user_id', 'role', 'created_at'],
  },
  invitation: {
    holds: 'Membership: pending invites',
    columns: [
      'id',
      'organization_id',
      'email',
      'role',
      'status',
      'expires_at',
      'created_at',
      'inviter_id',
    ],
  },
  outbox_message: {
    holds:
      "The outbox: each change a workspace's cell must hear about, as workspace ids, its region, person ids and roles, and how its delivery went",
    columns: [
      'organization_id',
      'sequence',
      'region',
      'change_type',
      'person_id',
      'role',
      'created_at',
      'attempts',
      'last_attempt_at',
      'last_error',
      'next_attempt_at',
      'delivered_at',
    ],
  },
  github_installation: {
    holds: 'App installs: which GitHub App installation belongs to which workspace',
    columns: [
      'installation_id',
      'organization_id',
      'account_id',
      'account_login',
      'account_type',
      'connected_by',
      'connected_at',
    ],
  },
  github_token_mint: {
    holds:
      'App installs: each token minted from the GitHub App, as its workspace, installation, purpose, repository ids, permissions and times, never the token or a repository name',
    columns: [
      'id',
      'organization_id',
      'installation_id',
      'purpose',
      'repository_ids',
      'permissions',
      'minted_at',
      'expires_at',
    ],
  },
};

const WHERE_THE_LIST_IS =
  'apps/cloud-global/AGENTS.md, "What is always global", and ALWAYS_GLOBAL in alwaysGlobal.test.ts';

type Tables = Record<string, string[]>;

/** Every table and column `tables` has that the always-global list does not, in words. */
function offTheList(tables: Tables): string[] {
  const problems: string[] = [];
  for (const [table, columns] of Object.entries(tables)) {
    const listed = ALWAYS_GLOBAL[table];
    if (!listed) {
      problems.push(
        `The table "${table}" is not on the always-global list (${WHERE_THE_LIST_IS}). ` +
          'Anything not on it belongs in a regional cell. If it is global, add it to the list first.',
      );
      continue;
    }
    for (const column of columns) {
      if (!listed.columns.includes(column)) {
        problems.push(
          `The column "${table}.${column}" is not on the always-global list (${WHERE_THE_LIST_IS}). ` +
            `"${table}" holds ${listed.holds}; anything else belongs in a regional cell.`,
        );
      }
    }
  }
  return problems;
}

/** The tables the Drizzle schema declares, with their columns. */
function schemaTables(): Tables {
  const tables: Tables = {};
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);
    tables[config.name] = config.columns.map((column) => column.name);
  }
  return tables;
}

/** The tables a migrated database has, in any schema but Postgres's own and Drizzle's journal. */
async function databaseTables(): Promise<Tables> {
  const { db, close } = openDatabase('pglite:memory');
  try {
    await migrateDatabase(db);
    const result = (await db.execute(
      sql`select table_schema, table_name, column_name from information_schema.columns
          where table_schema not in ('pg_catalog', 'information_schema', 'drizzle')`,
    )) as { rows: { table_schema: string; table_name: string; column_name: string }[] };
    const tables: Tables = {};
    for (const row of result.rows) {
      const name =
        row.table_schema === 'public' ? row.table_name : `${row.table_schema}.${row.table_name}`;
      tables[name] = [...(tables[name] ?? []), row.column_name];
    }
    return tables;
  } finally {
    await close();
  }
}

/** Exactly the tables and columns on the list, for the tests of `offTheList` itself. */
const listed = (): Tables =>
  Object.fromEntries(Object.entries(ALWAYS_GLOBAL).map(([table, { columns }]) => [table, columns]));

describe('the always-global list', () => {
  it('holds every table and column the schema declares', () => {
    const tables = schemaTables();
    // So a reader that finds nothing cannot pass.
    expect(tables.organization).toContain('region');
    expect(offTheList(tables)).toEqual([]);
  });

  it('holds every table and column a migrated database has', async () => {
    const tables = await databaseTables();
    expect(tables.organization).toContain('region');
    expect(offTheList(tables)).toEqual([]);
  });

  it('names a table that is not on it, and points at the list', () => {
    const withFactories = { ...listed(), factory: ['id', 'organization_id', 'definition'] };
    expect(offTheList(withFactories)).toEqual([
      expect.stringMatching(
        /^The table "factory" is not on the always-global list \(apps\/cloud-global\/AGENTS\.md, "What is always global"/,
      ),
    ]);
  });

  it('names a column that is not on it', () => {
    const tables = listed();
    const withDefinition = {
      ...tables,
      organization: [...(tables.organization ?? []), 'factory_definition'],
    };
    expect(offTheList(withDefinition)).toEqual([
      expect.stringContaining('The column "organization.factory_definition" is not on'),
    ]);
  });
});
