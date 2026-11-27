import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';

/** One part's answer to whether it can do its work: its `checkHealth` use case, on its probe. */
export type HealthCheck = () => Promise<boolean>;

const json = <Schema extends z.ZodType>(schema: Schema, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

/**
 * The ring's one route of its own: whether the app can do its work. It needs no session and no
 * `x-consola-workspace`, since it says nothing a person or a workspace holds.
 */
export const getHealth = createRoute({
  method: 'get',
  path: '/api/health',
  summary: 'Whether the service can reach its database',
  description: 'Needs no session: it says nothing a person or a workspace holds.',
  responses: {
    200: json(z.strictObject({ ok: z.literal(true) }), 'It can.'),
    503: json(z.strictObject({ ok: z.literal(false) }), 'It cannot.'),
  },
});

/** The ring's routes, in the order `registerHealthRoute` registers them. */
export const RING_ROUTES = [getHealth];

/**
 * `GET /api/health` on `app`, over every part's check: 200 only when each one says it can work,
 * else 503. The checks are asked together, and one that throws counts as one that cannot.
 */
export function registerHealthRoute(app: OpenAPIHono, checks: readonly HealthCheck[]): void {
  app.openapi(getHealth, async (c) => {
    const answers = await Promise.all(checks.map((check) => check().catch(() => false)));
    if (answers.every(Boolean)) return c.json({ ok: true } as const, 200);
    return c.json({ ok: false } as const, 503);
  });
}
