import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type {
  GitHubEventStore,
  InstallationStore,
  TokenMintStore,
} from '../../application/gitHubPorts.js';
import { createGitHubEventStore } from './gitHubEvents.js';
import { createInstallationStore } from './installationStore.js';
import { createTokenMintStore } from './tokenMintStore.js';

/**
 * A Drizzle database, on PGlite or Postgres, that holds GitHub's tables (`gitHubTables.ts`).
 * The stores build every query from those tables themselves, never through the schema's
 * relational queries, so a database opened with any schema will do: the company part's, or one
 * opened with none in a test.
 */
export type GitHubDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** GitHub's stores, on one Drizzle database. */
export function createGitHubStores(db: GitHubDatabase): {
  installations: InstallationStore;
  mints: TokenMintStore;
  events: GitHubEventStore;
} {
  return {
    installations: createInstallationStore(db),
    mints: createTokenMintStore(db),
    events: createGitHubEventStore(db),
  };
}
