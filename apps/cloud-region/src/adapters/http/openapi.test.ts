import { describe, expect, it } from 'vitest';
import { createRunnerSocket } from '../runner/runnerSocket.js';
import { createApp, describeApi } from './app.js';
import { ROUTES } from './contract.js';

/** The routes are only described here, never run, so no dependency is ever reached. */
const unreachable = new Proxy(
  {},
  {
    get: () => {
      throw new Error('Describing the API runs no route');
    },
  },
);

const app = createApp({
  region: 'eu',
  health: unreachable as never,
  tokens: unreachable as never,
  deliveries: unreachable as never,
  events: unreachable as never,
  workspaceCopies: unreachable as never,
  gitHubEvents: unreachable as never,
  teams: unreachable as never,
  factories: unreachable as never,
  runs: unreachable as never,
  clock: unreachable as never,
  cloudSessions: unreachable as never,
  // The real socket route, so what the app serves is what it serves in a cell.
  runner: createRunnerSocket({ settings: null, ports: unreachable as never }).routes,
  report: () => {},
});

describe('openapi.json', () => {
  // `pnpm --filter @consola/cloud-region openapi:generate` rewrites it; CI fails while it is stale.
  it('is the contract, as generated', async () => {
    await expect(`${JSON.stringify(describeApi(app), null, 2)}\n`).toMatchFileSnapshot(
      '../../../openapi.json',
    );
  });

  // `.nullable()` on a named schema renames the nullable copy after it, which makes every other
  // use of the name nullable too. A use that may be null is `z.union([Named, z.null()])`.
  it('names no schema that may be null', () => {
    const schemas = describeApi(app).components?.schemas ?? {};
    const nullable = Object.entries(schemas).filter(([, schema]) => {
      const type = 'type' in schema ? schema.type : undefined;
      return Array.isArray(type) && type.includes('null');
    });
    expect(nullable.map(([name]) => name)).toEqual([]);
  });

  it('describes every route in the contract, and only those', () => {
    const described = Object.entries(describeApi(app).paths ?? {}).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method} ${path}`),
    );
    expect(described.sort()).toEqual(ROUTES.map((r) => `${r.method} ${r.path}`).sort());
  });

  // Hono lists a route once per handler in its chain, so each is counted once.
  const served = [...new Set(app.routes.map((route) => `${route.method} ${route.path}`))];

  it('declares every route the app serves, but the ones outside the contract', () => {
    const declared = ROUTES.map(
      (route) => `${route.method.toUpperCase()} ${route.path.replaceAll(/\{(.+?)\}/g, ':$1')}`,
    );
    expect(served.filter((route) => !OUTSIDE_THE_CONTRACT.includes(route)).sort()).toEqual(
      declared.sort(),
    );
  });

  it('lists no exception the app no longer serves', () => {
    expect(OUTSIDE_THE_CONTRACT.filter((route) => !served.includes(route))).toEqual([]);
  });
});

/** What the app serves that is no route of the contract, each with why. */
const OUTSIDE_THE_CONTRACT = [
  // The token check in front of every route after the open ones (`requireCaller`): it answers
  // nothing of its own but the token failures each of those routes declares.
  'ALL /*',
  // The runner's socket (`adapters/runner`): a WebSocket upgrade, which OpenAPI does not
  // describe, behind the runner's secret rather than a cell token. No client calls it through the
  // contract: only a runner opens it, and what it says over it is `@consola/runner-protocol`'s.
  'GET /api/runner',
];
