import { describe, expect, it } from 'vitest';
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
  handleAuth: async () => {
    throw new Error('Describing the API runs no route');
  },
  currentSession: async () => {
    throw new Error('Describing the API runs no route');
  },
  webOrigin: 'http://localhost:5175',
  workspaces: unreachable as never,
  memberships: unreachable as never,
  sessions: unreachable as never,
  cellTokens: unreachable as never,
  installations: unreachable as never,
  github: unreachable as never,
  installStates: unreachable as never,
  health: unreachable as never,
});

describe('openapi.json', () => {
  // `pnpm --filter @consola/cloud-global openapi:generate` rewrites it; CI fails while it is stale.
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
});

/**
 * What the app serves that is not the contract's to describe, and why. Nothing else may be: a
 * route registered with `app.get`, `app.post` and the like, or with `app.openapi` but left out of
 * `ROUTES`, fails the test below. Add to this list only what no client calls through the
 * contract, with the reason.
 */
const OUTSIDE_THE_CONTRACT = [
  // Better Auth's own routes: sign-in, sessions. The web app calls them through Better Auth's
  // client, and Better Auth decides their shapes.
  'ALL /api/auth/*',
  // The origin check every change passes (`app.use`), which answers only 403 `bad_origin`.
  'ALL /api/*',
];

describe('the contract', () => {
  it('declares every route the app serves', () => {
    // A route with middleware or a body schema is one entry per handler in its chain.
    const served = [...new Set(app.routes.map((route) => `${route.method} ${route.path}`))];
    const declared = ROUTES.map(
      (route) => `${route.method.toUpperCase()} ${route.path.replaceAll(/\{(.+?)\}/g, ':$1')}`,
    );
    expect(served.filter((route) => !OUTSIDE_THE_CONTRACT.includes(route)).sort()).toEqual(
      declared.sort(),
    );
  });

  it('serves what it leaves outside the contract', () => {
    const served = new Set(app.routes.map((route) => `${route.method} ${route.path}`));
    expect(OUTSIDE_THE_CONTRACT.filter((route) => !served.has(route))).toEqual([]);
  });
});
