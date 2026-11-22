// Read only by the Better Auth schema CLI (`pnpm --filter @consola/cloud-global auth:generate`),
// which needs an auth configuration to know which tables to describe. It builds the service's
// own `createAuth`, so the schema follows what runs. Nothing here runs in the service, and none
// of these values is real.
import type { CloudConfig } from '../../config.js';
import { openDatabase } from '../persistence/database.js';
import { createDrizzleStores } from '../persistence/stores.js';
import { createAuth } from './betterAuth.js';

const placeholder: CloudConfig = {
  databaseUrl: 'pglite:memory',
  authSecret: 'placeholder-secret-for-the-schema-cli-only',
  publicUrl: 'http://localhost:5175',
  port: 3100,
  google: { clientId: 'placeholder', clientSecret: 'placeholder' },
  cellTokenPrivateKey: { kty: 'OKP', crv: 'Ed25519', x: 'placeholder', d: 'placeholder' },
  cellUrls: {},
};

const { db } = openDatabase(placeholder.databaseUrl);
const stores = createDrizzleStores(db);

export const auth = createAuth({
  db,
  config: placeholder,
  people: stores.people,
  memberships: stores.memberships,
  sessions: stores.sessions,
});
