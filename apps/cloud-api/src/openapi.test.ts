import type { OpenAPIHono } from '@hono/zod-openapi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeApi, ROUTES } from './compose.js';
import { loadConfig } from './config.js';
import { describeApi } from './http/frontDoor.js';
import { openDatabase } from './persistence/database.js';
import type { OpenDatabase } from './persistence/database.js';

// The app as `main.ts` composes it, so what is described and served is what runs. Its routes are
// only described and listed here, never run, so the database is never migrated or asked.

/** Stand-ins, never real credentials: the least a configuration needs. */
const config = loadConfig({
  DATABASE_URL: 'pglite:memory',
  BETTER_AUTH_SECRET: 'sprocket-test-secret-that-is-long-enough-to-sign-with',
  PUBLIC_URL: 'http://localhost:5175',
  GOOGLE_CLIENT_ID: 'sprocket-test-client-id',
  GOOGLE_CLIENT_SECRET: 'sprocket-test-client-secret',
});

let database: OpenDatabase;
let app: OpenAPIHono;

beforeAll(async () => {
  database = openDatabase(config.databaseUrl);
  ({ app } = await composeApi({ db: database, config }));
});

afterAll(async () => {
  await database.close();
});

describe('openapi.json', () => {
  // `pnpm --filter @consola/cloud-api openapi:generate` rewrites it; CI fails while it is stale.
  it('is the contract, as generated from the composed app', async () => {
    await expect(`${JSON.stringify(describeApi(app), null, 2)}\n`).toMatchFileSnapshot(
      '../openapi.json',
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

  it('declares no header a page sends on every company route', () => {
    // `x-consola-workspace` is set by the web app's client for every company call. Declared as a
    // required parameter, it would be one more thing every generated call has to pass by hand.
    const parameters = Object.values(describeApi(app).paths ?? {}).flatMap((item) =>
      Object.values(item).flatMap((operation: { parameters?: Array<{ name?: string }> }) =>
        (operation.parameters ?? []).map((parameter) => parameter.name),
      ),
    );
    expect(parameters).not.toContain('x-consola-workspace');
  });
});

/**
 * What the app serves that is no route of the contract, and why. Nothing else may be: a route
 * registered with `app.get`, `app.post` and the like, or with `app.openapi` but left out of its
 * part's list (and so of `ROUTES`), fails the tests below. Add to this list only what no client
 * calls through the contract, with the reason.
 */
const OUTSIDE_THE_CONTRACT = [
  // Better Auth's own routes: sign-in, sessions. The web app calls them through Better Auth's
  // client, and Better Auth decides their shapes.
  'ALL /api/auth/*',
  // The front door's origin check every change passes (`app.use`), which answers only 403
  // `bad_origin`.
  'ALL /api/*',
  // The runner's socket (`company/adapters/runner`): a WebSocket upgrade, which OpenAPI does not
  // describe, behind the runner's secret rather than a session. No client calls it through the
  // contract: only a runner opens it, and what it says over it is `@consola/runner-protocol`'s.
  'GET /api/runner',
];

describe('the contract', () => {
  // Hono lists a route once per handler in its chain, so each is counted once.
  const served = () => [...new Set(app.routes.map((route) => `${route.method} ${route.path}`))];

  it('declares every route the app serves, but the ones outside the contract', () => {
    const declared = ROUTES.map(
      (route) => `${route.method.toUpperCase()} ${route.path.replaceAll(/\{(.+?)\}/g, ':$1')}`,
    );
    expect(
      served()
        .filter((route) => !OUTSIDE_THE_CONTRACT.includes(route))
        .sort(),
    ).toEqual(declared.sort());
  });

  it('lists no exception the app no longer serves', () => {
    expect(OUTSIDE_THE_CONTRACT.filter((route) => !served().includes(route))).toEqual([]);
  });

  it('lists every route once', () => {
    const keys = ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
  });
});
