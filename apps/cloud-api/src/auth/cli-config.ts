// Read only by the Better Auth schema CLI (`pnpm --filter @consola/cloud-api auth:generate`),
// which needs an auth configuration to know which tables to describe. Nothing here runs in
// the service, and none of these values is real.
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { PGlite } from '@electric-sql/pglite';
import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/pglite';

export const auth = betterAuth({
  secret: 'placeholder-secret-for-the-schema-cli-only',
  baseURL: 'http://localhost:3100',
  database: drizzleAdapter(drizzle(new PGlite()), { provider: 'pg' }),
  socialProviders: {
    google: { clientId: 'placeholder', clientSecret: 'placeholder' },
  },
  plugins: [organization({ allowUserToCreateOrganization: false })],
});
