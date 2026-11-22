import { Hono } from 'hono';
import { checkHealth } from '../../application/health.js';
import type { HealthProbe } from '../../application/ports.js';
import type { Region } from '../../domain/region.js';

/**
 * The cell's HTTP API, every route under `/api`. Each route asks a use case and maps its answer
 * to a status and a body.
 */
export function createApp(deps: { region: Region; health: HealthProbe }): Hono {
  const { region, health } = deps;
  const app = new Hono();

  // The region says which cell answered, so whatever routes to cells can check it reached the
  // one it meant.
  app.get('/api/health', async (c) => {
    if (await checkHealth(health)) return c.json({ ok: true, region });
    return c.json({ ok: false, region }, 503);
  });

  return app;
}
