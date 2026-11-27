import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import type { Database as AccountsDatabase } from '../accounts/adapters/persistence/database.js';
import { schema as accountsSchema } from '../accounts/adapters/persistence/schema.js';
import type { WorkspaceStoreHooks } from '../accounts/adapters/persistence/workspaceStore.js';
import type {
  Database as CompanyDatabase,
  Transaction as CompanyTransaction,
} from '../company/adapters/persistence/database.js';
import * as gitHubTables from '../company/adapters/persistence/gitHubTables.js';
import { schema as companySchema } from '../company/adapters/persistence/schema.js';
import { openWorkspace } from '../company/adapters/persistence/teams.js';

/**
 * Every table the app holds, both parts': the one schema, put together only here, where both
 * parts' tables are visible. `drizzle.config.ts` generates the one migration chain (`drizzle/`)
 * from the same files, and `src/rules.test.ts` checks it against the two rules. No store is typed
 * over it: each part types its own over its own tables alone.
 */
export const SCHEMA = { ...accountsSchema, ...companySchema, ...gitHubTables };

/**
 * The one database, as each part reads and writes it: a Drizzle instance per part, each typed
 * over that part's own tables, on one client. So the two share every connection and every
 * transaction, and neither sees the other's tables in its types.
 */
export type AppDatabase = {
  accounts: AccountsDatabase;
  company: CompanyDatabase;
};

export type OpenDatabase = AppDatabase & { close(): Promise<void> };

// The app's one migration chain, which holds every part's tables. Resolves from both
// `src/persistence` and `dist/persistence`.
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

const PGLITE_PREFIX = 'pglite:';

/** How each database this module opened is migrated, by the client it was opened on. */
const migrators = new WeakMap<object, () => Promise<void>>();

/**
 * Opens the database `url` names: `pglite:memory`, `pglite:<folder>` (made if missing), or
 * `postgres://` / `postgresql://`, which a pool serves. Nothing is migrated yet
 * (`migrateDatabase`).
 */
export function openDatabase(url: string): OpenDatabase {
  if (url.startsWith(PGLITE_PREFIX)) {
    const location = url.slice(PGLITE_PREFIX.length);
    if (location === '') throw new Error('A pglite: database needs "memory" or a folder path.');
    let client: PGlite;
    if (location === 'memory') {
      client = new PGlite();
    } else {
      mkdirSync(dirname(location), { recursive: true });
      client = new PGlite(location);
    }
    const opened: OpenDatabase = {
      accounts: drizzlePglite(client, { schema: accountsSchema }) as unknown as AccountsDatabase,
      company: drizzlePglite(client, { schema: companySchema }) as unknown as CompanyDatabase,
      close: () => client.close(),
    };
    migrators.set(opened, () =>
      migratePglite(drizzlePglite(client), { migrationsFolder: MIGRATIONS_FOLDER }),
    );
    return opened;
  }

  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pool = new pg.Pool({ connectionString: url });
    // An idle connection that breaks (Postgres restarting, say) is reported here, and an
    // unheard 'error' would end the process. The pool opens a new connection when next asked.
    pool.on('error', (error) => {
      console.error(`A database connection was lost: ${error.message.split('\n')[0]}`);
    });
    const opened: OpenDatabase = {
      accounts: drizzleNodePg(pool, { schema: accountsSchema }) as unknown as AccountsDatabase,
      company: drizzleNodePg(pool, { schema: companySchema }) as unknown as CompanyDatabase,
      close: () => pool.end(),
    };
    migrators.set(opened, () =>
      migrateNodePg(drizzleNodePg(pool), { migrationsFolder: MIGRATIONS_FOLDER }),
    );
    return opened;
  }

  const scheme = url.split(':')[0] ?? url;
  throw new Error(
    `Unsupported database scheme "${scheme}". Use pglite:memory, pglite:<path>, postgres:// or postgresql://.`,
  );
}

/** Applies every migration of the one chain the database does not have yet. */
export async function migrateDatabase(database: OpenDatabase): Promise<void> {
  const migrate = migrators.get(database);
  if (!migrate) throw new Error('This database was not opened with openDatabase.');
  await migrate();
}

/**
 * What accounts' workspace store runs inside the transaction that makes a workspace: company's
 * `openWorkspace`, which makes its first team with the owner in it, so a workspace is born whole
 * or not at all.
 */
export const workspaceOpening: WorkspaceStoreHooks = {
  onCreated: (tx, opened) =>
    // The one cast of a transaction: accounts opened it, typed over accounts' tables, and company
    // writes its own tables in it. Both parts' Drizzle instances are on one client (above), so it
    // is a transaction on the one database whatever its type says, and `openWorkspace` builds its
    // queries from company's tables alone, never through the schema's relational queries.
    openWorkspace(tx as unknown as CompanyTransaction, opened),
};
