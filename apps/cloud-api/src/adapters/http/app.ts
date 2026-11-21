import { Hono } from 'hono';
import { checkHealth } from '../../application/health.js';
import { describeMe } from '../../application/me.js';
import type { HealthProbe, MembershipStore } from '../../application/ports.js';
import type { Organization, Person } from '../../domain/organization.js';

/**
 * The HTTP API. Every route sits under `/api`, which the web app proxies to this service. Each
 * route asks a use case and maps its answer to a status and a body; sign-in itself is handed to
 * `handleAuth` whole.
 */
export function createApp(deps: {
  handleAuth: (request: Request) => Promise<Response>;
  currentPerson: (headers: Headers) => Promise<Person | null>;
  organization: Organization;
  memberships: MembershipStore;
  health: HealthProbe;
}): Hono {
  const { handleAuth, currentPerson, organization, memberships, health } = deps;
  const app = new Hono();

  app.all('/api/auth/*', (c) => handleAuth(c.req.raw));

  app.get('/api/org', (c) => c.json({ name: organization.name, slug: organization.slug }));

  app.get('/api/me', async (c) => {
    const person = await currentPerson(c.req.raw.headers);
    const answer = await describeMe(memberships, organization, person);
    if (answer.kind === 'signed-out') return c.json({ error: 'signed_out' }, 401);
    if (answer.kind === 'not-member') return c.json({ error: 'not_a_member' }, 403);
    return c.json(answer.me);
  });

  app.get('/api/health', async (c) => {
    if (await checkHealth(health)) return c.json({ ok: true });
    return c.json({ ok: false }, 503);
  });

  return app;
}
