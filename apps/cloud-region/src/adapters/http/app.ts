import { OpenAPIHono } from '@hono/zod-openapi';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { checkHealth } from '../../application/health.js';
import { describeMe } from '../../application/me.js';
import type {
  Clock,
  CloudSessionPorts,
  DeliveryVerifier,
  FactoryStore,
  GitHubEventStore,
  HealthProbe,
  TeamStore,
  TokenVerifier,
  WorkspaceCopies,
} from '../../application/ports.js';
import type { Region } from '../../domain/region.js';
import { type CellEnv, requireCaller } from './caller.js';
import { cloudSessionRoutes } from './cloudSessions.js';
import { getHealth, getMe } from './contract.js';
import { factoryRoutes } from './factories.js';
import { gitHubEventRoutes } from './gitHubEvents.js';
import { outboxRoutes } from './outbox.js';
import { teamRoutes } from './teams.js';

/** What the OpenAPI document says about the cell, beside its routes. */
const DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'Consola Cloud regional cell',
    version: '0',
    description:
      "What a workspace holds in its region. Every route but the health check, the outbox's " +
      'deliveries and the GitHub events cloud-global passes on takes a cell token, minted by ' +
      'cloud-global for one workspace (`Authorization: Bearer`), and reads and writes that ' +
      'workspace alone.',
  },
};

/**
 * The cell's HTTP API, every route under `/api` and in the contract (`contract.ts`), which
 * TypeScript checks each answer against. Each route asks a use case and maps its answer to a
 * status and a body.
 *
 * Three routes answer without a cell token: `GET /api/health`, for whatever probes cells,
 * `POST OUTBOX_DELIVERY_PATH`, where `cloud-global` delivers its outbox, and
 * `POST GITHUB_EVENT_DELIVERY_PATH`, where it passes on GitHub's webhook events, each delivery
 * signed with the cell token's key. `GET /api/runner`, the runner's socket, answers without one
 * too, behind the runner's own secret (`runner`, built by `adapters/runner` and handed over by
 * `compose.ts`). Every other request, an unknown path included, must carry a token
 * (`requireCaller`), so a route added below the check gets the caller and nothing else, and none
 * takes a workspace id from the request. `report` hears what the cell logs about deliveries.
 *
 * A body is checked for its shape after the token, and before the route's use case: one of the
 * wrong shape is 400 `invalid_request`, one that is not JSON at all too, and one sent without a
 * JSON content type 415 `unsupported_media_type`, on every route that takes JSON alike.
 */
export function createApp(deps: {
  region: Region;
  health: HealthProbe;
  tokens: TokenVerifier;
  deliveries: DeliveryVerifier;
  /** Checks the GitHub events `cloud-global` passes on: the `typ` is `GITHUB_EVENT_TYPE`. */
  events: DeliveryVerifier;
  workspaceCopies: WorkspaceCopies;
  gitHubEvents: GitHubEventStore;
  teams: TeamStore;
  factories: FactoryStore;
  clock: Clock;
  cloudSessions: CloudSessionPorts;
  /** The runner's socket route, which checks the runner's secret itself. */
  runner: Hono;
  report?: (line: string) => void;
}): OpenAPIHono<CellEnv> {
  const {
    region,
    health,
    tokens,
    deliveries,
    events,
    workspaceCopies,
    gitHubEvents,
    teams,
    factories,
    clock,
    cloudSessions,
  } = deps;
  const report = deps.report ?? ((line: string) => console.error(line));
  // A body of the wrong shape is 400 `invalid_request`, never the validator's own answer, which
  // is not in the contract.
  const app = new OpenAPIHono<CellEnv>({
    defaultHook: (result, c) =>
      result.success ? undefined : c.json({ error: 'invalid_request' } as const, 400),
  });

  // Hono's validator throws on a body that is not JSON, before any route's hook sees it.
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 400) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (error instanceof HTTPException && error.status === 415) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    if (error instanceof HTTPException) return error.getResponse();
    console.error(error);
    return c.text('Internal Server Error', 500);
  });

  // Open, for whatever probes cells. The region says which cell answered, so whatever routes to
  // cells can check it reached the one it meant. It says nothing a workspace holds.
  app.openapi(getHealth, async (c) => {
    if (await checkHealth(health)) return c.json({ ok: true, region } as const, 200);
    return c.json({ ok: false, region } as const, 503);
  });

  // No token, since no person sends it: its signature is checked instead (`outboxRoutes`).
  app.route('/', outboxRoutes({ region, deliveries, workspaceCopies, report }));
  app.route('/', gitHubEventRoutes({ region, events, gitHubEvents, report }));

  // No token either: a runner is no person, and presents its secret instead.
  app.route('/', deps.runner);

  // Everything registered from here on is behind the check.
  app.use('*', requireCaller({ region, tokens, clock }));

  // Who is asking, as this cell sees them.
  app.openapi(getMe, (c) => c.json(describeMe(c.var.caller), 200));

  teamRoutes(app, teams);
  factoryRoutes(app, teams, factories);

  // A person's cloud sessions.
  app.route('/', cloudSessionRoutes(cloudSessions));

  return app;
}

/** The OpenAPI document of `app`'s contract, as `openapi.json` holds it. */
export function describeApi(app: OpenAPIHono<CellEnv>) {
  return app.getOpenAPI31Document(DOCUMENT);
}
