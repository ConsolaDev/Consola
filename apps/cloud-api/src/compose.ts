import type { BetterAuthPlugin } from 'better-auth';
import type { Hono } from 'hono';
import { type CloudAuth, createAuth } from './adapters/auth/betterAuth.js';
import { createApp } from './adapters/http/app.js';
import type { Database } from './adapters/persistence/database.js';
import { createDrizzleStores } from './adapters/persistence/stores.js';
import type { CloudConfig } from './config.js';
import type { Organization } from './domain/organization.js';

/**
 * The service, assembled: the one place adapters meet use cases. `main.ts` serves what this
 * returns, and the HTTP tests build through it too, so they test the wiring that runs.
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
    currentPerson: async (headers) => {
      const signedIn = await auth.api.getSession({ headers });
      if (!signedIn) return null;
      const { user } = signedIn;
      return { id: user.id, name: user.name, email: user.email, image: user.image ?? null };
    },
    organization,
    memberships: stores.memberships,
    health: stores.health,
  });

  return { app, auth };
}
