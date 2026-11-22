import { Hono } from 'hono';
import { checkHealth } from '../../application/health.js';
import { describeMe } from '../../application/me.js';
import type {
  Clock,
  DeliveryVerifier,
  HealthProbe,
  TokenVerifier,
  WorkspaceCopies,
} from '../../application/ports.js';
import type { Region } from '../../domain/region.js';
import { requireCaller } from './caller.js';
import { outboxRoutes } from './outbox.js';

/**
 * The cell's HTTP API, every route under `/api`. Each route asks a use case and maps its answer
 * to a status and a body.
 *
 * Two routes answer without a cell token: `GET /api/health`, for whatever probes cells, and
 * `POST OUTBOX_DELIVERY_PATH`, where `cloud-global` delivers its outbox, each delivery signed
 * with the cell token's key. Every other request, an unknown path included, must carry a token
 * (`requireCaller`), so a route added below the check gets the caller and nothing else, and none
 * takes a workspace id from the request. `report` hears what the cell logs about deliveries.
 */
export function createApp(deps: {
  region: Region;
  health: HealthProbe;
  tokens: TokenVerifier;
  deliveries: DeliveryVerifier;
  workspaceCopies: WorkspaceCopies;
  clock: Clock;
  report?: (line: string) => void;
}): Hono {
  const { region, health, tokens, deliveries, workspaceCopies, clock } = deps;
  const report = deps.report ?? ((line: string) => console.error(line));
  const app = new Hono();

  // Open, for whatever probes cells. The region says which cell answered, so whatever routes to
  // cells can check it reached the one it meant. It says nothing a workspace holds.
  app.get('/api/health', async (c) => {
    if (await checkHealth(health)) return c.json({ ok: true, region });
    return c.json({ ok: false, region }, 503);
  });

  // No token, since no person sends it: its signature is checked instead (`outboxRoutes`).
  app.route('/', outboxRoutes({ region, deliveries, workspaceCopies, report }));

  // Everything registered from here on is behind the check.
  const cell = app.use('*', requireCaller({ region, tokens, clock }));

  // Who is asking, as this cell sees them.
  cell.get('/api/me', (c) => c.json(describeMe(c.var.caller)));

  return app;
}
