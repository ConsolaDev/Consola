// Read only by the Better Auth schema CLI (`pnpm --filter @consola/cloud-api auth:generate`),
// which needs an auth configuration to know which tables to describe. It builds the service's
// own `createAuth`, so the schema follows what runs. Nothing here runs in the service, and none
// of these values is real.
import type { CloudConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { createAuth } from './auth.js';

const placeholder: CloudConfig = {
  databaseUrl: 'pglite:memory',
  authSecret: 'placeholder-secret-for-the-schema-cli-only',
  publicUrl: 'http://localhost:5175',
  port: 3100,
  google: { clientId: 'placeholder', clientSecret: 'placeholder' },
  organization: { name: 'Sprocket', slug: 'sprocket' },
};

export const auth = createAuth({
  db: openDatabase(placeholder.databaseUrl).db,
  config: placeholder,
  organizationId: 'placeholder',
});
