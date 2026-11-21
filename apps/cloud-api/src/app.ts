import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { CloudAuth } from './auth/auth.js';
import type { Database } from './db/database.js';
import { findMembership, type Organization } from './organization.js';

/** The HTTP API. Every route sits under `/api`, which the web app proxies to this service. */
export function createApp(deps: {
  db: Database;
  auth: CloudAuth;
  organization: Organization;
}): Hono {
  const { db, auth, organization } = deps;
  const app = new Hono();

  app.all('/api/auth/*', (c) => auth.handler(c.req.raw));

  app.get('/api/org', (c) => c.json({ name: organization.name, slug: organization.slug }));

  app.get('/api/me', async (c) => {
    const signedIn = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!signedIn) return c.json({ error: 'signed_out' }, 401);

    const { user } = signedIn;
    const membership = await findMembership(db, {
      organizationId: organization.id,
      userId: user.id,
    });
    if (!membership) return c.json({ error: 'not_a_member' }, 403);

    return c.json({
      user: { id: user.id, name: user.name, email: user.email, image: user.image ?? null },
      organization: { id: organization.id, name: organization.name, slug: organization.slug },
      role: membership.role,
    });
  });

  app.get('/api/health', async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  return app;
}
