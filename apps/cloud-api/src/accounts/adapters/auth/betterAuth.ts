import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { APIError, betterAuth } from 'better-auth';
import type { BetterAuthPlugin } from 'better-auth';
import { organization } from 'better-auth/plugins';
import type { MembershipStore, PeopleStore, SessionStore } from '../../application/ports.js';
import { mayCreateAccount, mayStartSession } from '../../application/signIn.js';
import { workspaceForNewSession } from '../../application/workspaces.js';
import type { CloudConfig } from '../../config.js';
import type { SignedIn } from '../../domain/person.js';
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
 * Better Auth's organisation plugin, for its tables only: `organization`, `member`,
 * `invitation` and the session's `active_organization_id`. Workspaces are Consola's own routes
 * (`adapters/http`), so every route the plugin brings is closed (`closedPaths`).
 */
function workspaceTables() {
  return organization({
    allowUserToCreateOrganization: false,
    disableOrganizationDeletion: true,
    // A workspace's region is fixed once set: `input: false` keeps it out of anything Better
    // Auth would accept from a request.
    schema: {
      organization: {
        additionalFields: { region: { type: 'string', required: true, input: false } },
      },
    },
  });
}

/**
 * Every path a plugin serves, so none of them is: read from the plugin itself, so a route a
 * Better Auth upgrade adds is closed too. Server-only endpoints have no path.
 */
export function closedPaths(plugin: BetterAuthPlugin): string[] {
  return Object.values(plugin.endpoints ?? {}).flatMap((endpoint) =>
    typeof endpoint.path === 'string' ? [endpoint.path] : [],
  );
}

/**
 * Better Auth for this deployment, which owns sign-in and sessions and nothing else: Google is
 * the only way in, and `mayJoin` is asked before an account is created (`mayCreateAccount`) and
 * before every new session (`mayStartSession`). A new session starts in the workspace
 * `workspaceForNewSession` picks, or in none. Signing in joins no workspace. Every error Better
 * Auth would show on a page of its own goes to the web app instead, as `?error=<code>`. The
 * hooks only call use cases; the queries are the stores'.
 *
 * Cookies keep Better Auth's defaults, httpOnly and SameSite=Lax, which it marks Secure exactly
 * when `baseURL` is https. Its cookie cache stays off, so every request reads its session from
 * the database, where `SessionStore` writes the active workspace. Its origin check keeps its
 * default. Rate limiting is turned on here, since Better Auth's default is on only when
 * NODE_ENV is production; it counts per client address from `x-forwarded-for`, which the web
 * app's proxy sets.
 */
export function createAuth(
  deps: {
    db: Database;
    config: CloudConfig;
    people: PeopleStore;
    memberships: MembershipStore;
    sessions: SessionStore;
  },
  extraPlugins: BetterAuthPlugin[] = [],
) {
  const { db, config, people, memberships, sessions } = deps;
  const tables = workspaceTables();
  return betterAuth({
    baseURL: config.publicUrl,
    secret: config.authSecret,
    trustedOrigins: [config.publicUrl],
    rateLimit: { enabled: true },
    onAPIError: { errorURL: config.publicUrl },
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    disabledPaths: closedPaths(tables),
    socialProviders: {
      google: {
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        prompt: 'select_account',
        overrideUserInfoOnSignIn: true,
      },
    },
    plugins: [tables, ...extraPlugins],
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
            const activeOrganizationId = await workspaceForNewSession(
              { memberships, sessions },
              session.userId,
            );
            return { data: { ...session, activeOrganizationId } };
          },
        },
      },
    },
  });
}

export type CloudAuth = ReturnType<typeof createAuth>;

/** A request's session as `SignedIn`, or null when it has none. */
export function currentSessionOf(auth: CloudAuth): (headers: Headers) => Promise<SignedIn | null> {
  return async (headers) => {
    const signedIn = await auth.api.getSession({ headers });
    if (!signedIn) return null;
    const { user, session } = signedIn;
    return {
      sessionId: session.id,
      person: { id: user.id, name: user.name, email: user.email, image: user.image ?? null },
      activeWorkspaceId: session.activeOrganizationId ?? null,
    };
  };
}
