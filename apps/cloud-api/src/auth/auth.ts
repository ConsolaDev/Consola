import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { APIError, type BetterAuthPlugin, betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import type { CloudConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { schema } from '../db/schema.js';
import { ensureMembership } from '../organization.js';
import { mayJoin } from './joinRule.js';

/**
 * Better Auth for this deployment: Google is the only way in, a verified email is required to
 * create an account, and every session belongs to the deployment's one organisation. Nobody
 * creates organisations through the API; `ensureOrganization` makes the one there is.
 *
 * Cookies keep Better Auth's defaults, httpOnly and SameSite=Lax, which it marks Secure exactly
 * when `baseURL` is https. Its origin check and rate limiting are left as they are.
 */
export function createAuth(
  deps: { db: Database; config: CloudConfig; organizationId: string },
  extraPlugins: BetterAuthPlugin[] = [],
) {
  const { db, config, organizationId } = deps;
  return betterAuth({
    baseURL: config.publicUrl,
    secret: config.authSecret,
    trustedOrigins: [config.publicUrl],
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    socialProviders: {
      google: {
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        prompt: 'select_account',
        overrideUserInfoOnSignIn: true,
      },
    },
    plugins: [organization({ allowUserToCreateOrganization: false }), ...extraPlugins],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!mayJoin(user)) {
              throw new APIError('FORBIDDEN', {
                message: 'A verified email address is required.',
              });
            }
            return { data: user };
          },
        },
      },
      session: {
        create: {
          before: async (session) => ({
            data: { ...session, activeOrganizationId: organizationId },
          }),
          after: async (session) => {
            await ensureMembership(db, { organizationId, userId: session.userId });
          },
        },
      },
    },
  });
}

export type CloudAuth = ReturnType<typeof createAuth>;
