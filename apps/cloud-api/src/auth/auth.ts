import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { APIError, type BetterAuthPlugin, betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import type { CloudConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { schema } from '../db/schema.js';
import { ensureMembership } from '../organization.js';
import { mayJoin } from './joinRule.js';

// The code is what Google's callback sends the web app as `?error=`; without one the callback
// answers the error as JSON instead of redirecting.
const notAllowedToJoin = () =>
  new APIError('FORBIDDEN', {
    code: 'email_not_verified',
    message: 'A verified email address is required.',
  });

/**
 * Better Auth for this deployment: Google is the only way in, `mayJoin` is asked before an
 * account is created and before every new session, and every session belongs to the
 * deployment's one organisation. Nobody creates or deletes organisations through the API;
 * `ensureOrganization` makes the one there is. Every error Better Auth would show on a page of
 * its own goes to the web app instead, as `?error=<code>`.
 *
 * Cookies keep Better Auth's defaults, httpOnly and SameSite=Lax, which it marks Secure exactly
 * when `baseURL` is https. Its origin check keeps its default. Rate limiting is turned on here,
 * since Better Auth's default is on only when NODE_ENV is production; it counts per client
 * address from `x-forwarded-for`, which the web app's proxy sets.
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
    rateLimit: { enabled: true },
    onAPIError: { errorURL: config.publicUrl },
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    socialProviders: {
      google: {
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        prompt: 'select_account',
        overrideUserInfoOnSignIn: true,
      },
    },
    plugins: [
      organization({ allowUserToCreateOrganization: false, disableOrganizationDeletion: true }),
      ...extraPlugins,
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!mayJoin(user)) throw notAllowedToJoin();
            return { data: user };
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const [user] = await db
              .select({ emailVerified: schema.user.emailVerified })
              .from(schema.user)
              .where(eq(schema.user.id, session.userId));
            if (!user || !mayJoin(user)) throw notAllowedToJoin();
            return { data: { ...session, activeOrganizationId: organizationId } };
          },
          after: async (session) => {
            await ensureMembership(db, { organizationId, userId: session.userId });
          },
        },
      },
    },
  });
}

export type CloudAuth = ReturnType<typeof createAuth>;
