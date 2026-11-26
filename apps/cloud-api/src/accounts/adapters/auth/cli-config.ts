// Read only by the Better Auth schema CLI (`pnpm --filter @consola/cloud-api auth:generate`),
// which needs an auth configuration to know which tables to describe. It builds the service's
// own `createAuth`, so the schema follows what runs. Nothing here runs in the service, and none
// of these values is real.
import { openDatabase } from '../persistence/database.js';
import { createDrizzleStores } from '../persistence/stores.js';
import { createAuth } from './betterAuth.js';
import type { AuthSettings } from './betterAuth.js';

const placeholder: AuthSettings = {
  authSecret: 'placeholder-secret-for-the-schema-cli-only',
  publicUrl: 'http://localhost:5175',
  google: { clientId: 'placeholder', clientSecret: 'placeholder' },
};

const { db } = openDatabase('pglite:memory');
const stores = createDrizzleStores(db);

export const auth = createAuth({
  db,
  config: placeholder,
  people: stores.people,
  memberships: stores.memberships,
  sessions: stores.sessions,
});
