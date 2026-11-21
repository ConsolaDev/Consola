import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { APIError, type BetterAuthPlugin, betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { joinOrganization } from '../../application/organization.js';
import type { MembershipStore, PeopleStore } from '../../application/ports.js';
import { mayCreateAccount, mayStartSession } from '../../application/signIn.js';
import type { CloudConfig } from '../../config.js';
import type { Database } from '../persistence/database.js';
import { schema } from '../persistence/schema.js';

// The code is what Google's callback sends the web app as `?error=`; without one the callback
// answers the error as JSON instead of redirecting.
const notAllowedToJoin = () =>
  new APIError('FORBIDDEN', {
    code: 'email_not_verified',
    message: 'A verified email address is required.',
  });

/**
 * Better Auth for this deployment: Google is the only way in, `mayJoin` is asked before an
 * account is created (`mayCreateAccount`) and before every new session (`mayStartSession`), and
 * every session belongs to the deployment's one organisation, which `joinOrganization` joins.
 * Nobody creates or deletes organisations through the API; `ensureOrganization` makes the one
 * there is. Every error Better Auth would show on a page of its own goes to the web app instead,
 * as `?error=<code>`. The hooks only call use cases; the queries are the stores'.
 *
 * Cookies keep Better Auth's defaults, httpOnly and SameSite=Lax, which it marks Secure exactly
 * when `baseURL` is https. Its origin check keeps its default. Rate limiting is turned on here,
 * since Better Auth's default is on only when NODE_ENV is production; it counts per client
 * address from `x-forwarded-for`, which the web app's proxy sets.
 */
export function createAuth(
  deps: {
    db: Database;
    config: CloudConfig;
    organizationId: string;
    people: PeopleStore;
    memberships: MembershipStore;
  },
  extraPlugins: BetterAuthPlugin[] = [],
) {
  const { db, config, organizationId, people, memberships } = deps;
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
            if (!mayCreateAccount(user)) throw notAllowedToJoin();
            return { data: user };
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            if (!(await mayStartSession(people, session.userId))) throw notAllowedToJoin();
            return { data: { ...session, activeOrganizationId: organizationId } };
          },
          after: async (session) => {
            await joinOrganization(memberships, { organizationId, userId: session.userId });
          },
        },
      },
    },
  });
}

export type CloudAuth = ReturnType<typeof createAuth>;
