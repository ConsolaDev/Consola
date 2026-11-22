import type { BetterAuthPlugin } from 'better-auth';
import type { Hono } from 'hono';
import { type CloudAuth, createAuth, currentSessionOf } from './adapters/auth/betterAuth.js';
import { createApp } from './adapters/http/app.js';
import type { Database } from './adapters/persistence/database.js';
import { createDrizzleStores } from './adapters/persistence/stores.js';
import type { CloudConfig } from './config.js';

/**
 * The service, assembled: the one place adapters are built and handed the ports they need.
 * `main.ts` serves what this returns once the database is migrated, and the HTTP tests build
 * through it too, so they test the wiring that runs.
 */
export function composeApi(
  deps: { db: Database; config: CloudConfig },
  extraPlugins: BetterAuthPlugin[] = [],
): { app: Hono; auth: CloudAuth } {
  const { db, config } = deps;
  const stores = createDrizzleStores(db);

  const auth = createAuth(
    {
      db,
      config,
      people: stores.people,
      memberships: stores.memberships,
      sessions: stores.sessions,
    },
    extraPlugins,
  );

  const app = createApp({
    handleAuth: (request) => auth.handler(request),
    currentSession: currentSessionOf(auth),
    webOrigin: config.publicUrl,
    workspaces: stores.workspaces,
    memberships: stores.memberships,
    sessions: stores.sessions,
    health: stores.health,
  });

  return { app, auth };
}
