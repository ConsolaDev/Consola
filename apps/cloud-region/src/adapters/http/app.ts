import { Hono } from 'hono';
import { checkHealth } from '../../application/health.js';
import { describeMe } from '../../application/me.js';
import type { Clock, HealthProbe, TokenVerifier } from '../../application/ports.js';
import type { Region } from '../../domain/region.js';
import { requireCaller } from './caller.js';

/**
 * The cell's HTTP API, every route under `/api`. Each route asks a use case and maps its answer
 * to a status and a body.
 *
 * Only `GET /api/health` answers without a cell token. Every other request, an unknown path
 * included, must carry one (`requireCaller`), so a route added below the check gets the caller
 * and nothing else, and none takes a workspace id from the request.
 */
export function createApp(deps: {
  region: Region;
  health: HealthProbe;
  tokens: TokenVerifier;
  clock: Clock;
}): Hono {
  const { region, health, tokens, clock } = deps;
  const app = new Hono();

  // Open, for whatever probes cells. The region says which cell answered, so whatever routes to
  // cells can check it reached the one it meant. It says nothing a workspace holds.
  app.get('/api/health', async (c) => {
    if (await checkHealth(health)) return c.json({ ok: true, region });
    return c.json({ ok: false, region }, 503);
  });

  // Everything registered from here on is behind the check.
  const cell = app.use('*', requireCaller({ region, tokens, clock }));

  // Who is asking, as this cell sees them.
  cell.get('/api/me', (c) => c.json(describeMe(c.var.caller)));

  return app;
}
