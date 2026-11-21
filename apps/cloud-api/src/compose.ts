import type { BetterAuthPlugin } from 'better-auth';
import type { Hono } from 'hono';
import { type CloudAuth, createAuth, currentPersonOf } from './adapters/auth/betterAuth.js';
import { createApp } from './adapters/http/app.js';
import type { Database } from './adapters/persistence/database.js';
import { createDrizzleStores } from './adapters/persistence/stores.js';
import { ensureOrganization } from './application/organization.js';
import type { CloudConfig } from './config.js';
import type { Organization } from './domain/organization.js';

/**
 * The deployment's one organisation, made or renamed from the configuration: the startup step
 * `composeApi` needs before it can run. `main.ts` calls it once the database is migrated.
 */
export function prepareOrganization(db: Database, config: CloudConfig): Promise<Organization> {
  return ensureOrganization(createDrizzleStores(db).organizations, config.organization);
}

/**
 * The service, assembled: the one place adapters are built and handed the ports they need.
 * `main.ts` serves what this returns, and the HTTP tests build through it too, so they test the
 * wiring that runs.
 */
export function composeApi(
  deps: { db: Database; config: CloudConfig; organization: Organization },
  extraPlugins: BetterAuthPlugin[] = [],
): { app: Hono; auth: CloudAuth } {
  const { db, config, organization } = deps;
  const stores = createDrizzleStores(db);

  const auth = createAuth(
    {
      db,
      config,
      organizationId: organization.id,
      people: stores.people,
      memberships: stores.memberships,
    },
    extraPlugins,
  );

  const app = createApp({
    handleAuth: (request) => auth.handler(request),
    currentPerson: currentPersonOf(auth),
    organization,
    memberships: stores.memberships,
    health: stores.health,
  });

  return { app, auth };
}
