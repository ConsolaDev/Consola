import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_KEYS_PATH,
  CELL_TOKEN_LIFETIME_SECONDS,
  type CellTokenGrant,
  cellTokenClaims,
  WORKSPACE_ROLES,
} from '@consola/cloud-contract';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  type JWTHeaderParameters,
  SignJWT,
} from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellEnv } from './adapters/http/caller.js';
import { type Database, migrateDatabase, openDatabase } from './adapters/persistence/database.js';
import { composeCell } from './compose.js';
import { type CellConfig, loadConfig } from './config.js';

const config: CellConfig = {
  databaseUrl: 'pglite:memory',
  region: 'eu',
  port: 3101,
  // Never fetched here: every cell below is handed a key set of its own, but the ones in "the
  // keys", which start a cloud-global of their own.
  cloudGlobalUrl: 'http://127.0.0.1:3100',
};

// Tokens are minted here the way cloud-global mints them (the contract's claims, signed with
// Ed25519 and naming the key's thumbprint), so no cloud-global has to run.

type SigningKey = { privateKey: CryptoKey; publicKey: CryptoKey; jwk: JWK; kid: string };

async function newSigningKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(CELL_TOKEN_ALGORITHM, {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  return {
    privateKey,
    publicKey,
    jwk: { ...jwk, kid, alg: CELL_TOKEN_ALGORITHM, use: 'sig' },
    kid,
  };
}

/** The key cloud-global signs with, which the cells trust, and one nobody published. */
let cloudGlobal: SigningKey;
let stranger: SigningKey;
/** What cloud-global publishes at CELL_TOKEN_KEYS_PATH. */
let published: JSONWebKeySet;

beforeAll(async () => {
  cloudGlobal = await newSigningKey();
  stranger = await newSigningKey();
  published = { keys: [cloudGlobal.jwk] };
});

const nowSeconds = () => Math.floor(Date.now() / 1000);

const grant = (overrides: Partial<CellTokenGrant> = {}): CellTokenGrant => ({
  personId: 'person-1',
  workspaceId: 'acme',
  role: 'member',
  region: 'eu',
  issuedAt: nowSeconds(),
  ...overrides,
});

const claims = (overrides: Partial<CellTokenGrant> = {}): Record<string, unknown> =>
  cellTokenClaims(grant(overrides));

function sign(
  payload: Record<string, unknown>,
  key: SigningKey = cloudGlobal,
  header: Partial<JWTHeaderParameters> = {},
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: CELL_TOKEN_ALGORITHM, kid: key.kid, ...header })
    .sign(key.privateKey);
}

/** A good token, as cloud-global would mint it. */
const mint = (overrides: Partial<CellTokenGrant> = {}) => sign(claims(overrides));

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

let app: Hono;
let db: Database;
let closeDatabase: () => Promise<void>;

async function openCell(cellConfig: CellConfig, keys: 'local' | 'remote' = 'local') {
  const opened = openDatabase(cellConfig.databaseUrl);
  await migrateDatabase(opened.db);
  // Built the way main.ts builds it, but for the key set a test hands it.
  const cellTokenKeys = keys === 'local' ? createLocalJWKSet(published) : undefined;
  const { app } = composeCell({ db: opened.db, config: cellConfig, cellTokenKeys });
  return { app, db: opened.db, close: () => opened.close() };
}

beforeEach(async () => {
  const cell = await openCell(config);
  ({ app, db } = cell);
  let closed = false;
  closeDatabase = async () => {
    if (closed) return;
    closed = true;
    await cell.close();
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDatabase();
});

describe('GET /api/health', () => {
  it('answers ok, with the region this cell serves, while the database answers', async () => {
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, region: 'eu' });
  });

  it('answers 503 once the database does not', async () => {
    await closeDatabase();
    const response = await app.request('/api/health');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, region: 'eu' });
  });

  it('names the region it is configured with', async () => {
    const us = await openCell({ ...config, region: 'us' });
    expect(await (await us.app.request('/api/health')).json()).toEqual({ ok: true, region: 'us' });
    await us.close();
  });

  it('needs no token, and ignores a bad one', async () => {
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/health', { headers: bearer('forged') })).status).toBe(200);
    expect((await app.request('/api/health', { method: 'HEAD' })).status).toBe(200);
  });
});

describe('GET /api/me', () => {
  it('answers the caller its token names: ids, role and region, and nothing more', async () => {
    const response = await app.request('/api/me', { headers: bearer(await mint()) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      personId: 'person-1',
      workspaceId: 'acme',
      role: 'member',
      region: 'eu',
    });
  });

  it('reads every role', async () => {
    for (const role of WORKSPACE_ROLES) {
      const response = await app.request('/api/me', { headers: bearer(await mint({ role })) });
      expect(await response.json()).toMatchObject({ role });
    }
  });

  it('takes the Bearer scheme in any case', async () => {
    const token = await mint();
    for (const authorization of [`bearer ${token}`, `BEARER  ${token}`]) {
      expect((await app.request('/api/me', { headers: { authorization } })).status).toBe(200);
    }
  });

  it('takes a token that is close to expiring, within the clocks allowed skew', async () => {
    // It expired 10 seconds ago by this clock; cloud-global's may be up to 30 behind.
    const issuedAt = nowSeconds() - CELL_TOKEN_LIFETIME_SECONDS - 10;
    const response = await app.request('/api/me', { headers: bearer(await mint({ issuedAt })) });
    expect(response.status).toBe(200);
  });
});

describe('a request without a token', () => {
  it('is 401, with a bearer challenge and no error code', async () => {
    const response = await app.request('/api/me');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(await response.json()).toEqual({ error: 'token_required' });
  });

  it('is what a request with another scheme is too', async () => {
    const response = await app.request('/api/me', {
      headers: { authorization: `Basic ${Buffer.from('acme:secret').toString('base64')}` },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('is what a token anywhere but the Authorization header is', async () => {
    const token = await mint();
    for (const [path, headers] of [
      [`/api/me?access_token=${token}`, {}],
      ['/api/me', { cookie: `token=${token}` }],
      ['/api/me', { 'x-cell-token': token }],
    ] as const) {
      const response = await app.request(path, { headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'token_required' });
    }
  });
});

describe('a request with a token the cell does not accept', () => {
  it.each<[string, () => Promise<string>]>([
    ['an empty one', async () => ''],
    ['a malformed one', async () => 'not-a-token'],
    ['three parts that are no JWT', async () => 'a.b.c'],
    [
      'a forged one: claims changed after signing',
      async () => {
        const [header, , signature] = (await mint()).split('.');
        return [header, base64url(claims({ workspaceId: 'sprocket' })), signature].join('.');
      },
    ],
    [
      "one signed by another key that names cloud-global's key",
      () => sign(claims(), stranger, { kid: cloudGlobal.kid }),
    ],
    ['one signed by a key cloud-global does not publish', () => sign(claims(), stranger)],
    ['an expired one', () => mint({ issuedAt: nowSeconds() - 3600 })],
    ['one minted in the future', () => mint({ issuedAt: nowSeconds() + 3600 })],
    [
      'one that lives longer than a cell token may',
      () => {
        const issuedAt = nowSeconds();
        return sign({ ...claims({ issuedAt }), exp: issuedAt + 3600 });
      },
    ],
    ['one for another audience', () => sign({ ...claims(), aud: 'consola-session' })],
    [
      'one with a claim the contract does not name',
      () => sign({ ...claims(), email: 'someone@sprocket.test' }),
    ],
    [
      'one missing a claim',
      () => {
        const { role: _role, ...rest } = claims();
        return sign(rest);
      },
    ],
    ['one with a role the contract does not list', () => sign({ ...claims(), role: 'root' })],
    ['one naming no key', () => sign(claims(), cloudGlobal, { kid: undefined })],
    [
      'an unsigned one (alg: none)',
      async () =>
        `${base64url({ alg: 'none', typ: 'JWT', kid: cloudGlobal.kid })}.${base64url(claims())}.`,
    ],
    [
      "an HS256 one whose secret is cloud-global's public key",
      async () => {
        const secret = new TextEncoder().encode(await exportSPKI(cloudGlobal.publicKey));
        return new SignJWT(claims())
          .setProtectedHeader({ alg: 'HS256', kid: cloudGlobal.kid })
          .sign(secret);
      },
    ],
    [
      "an HS256 one whose secret is cloud-global's published key",
      async () => {
        const secret = new TextEncoder().encode(JSON.stringify(cloudGlobal.jwk));
        return new SignJWT(claims())
          .setProtectedHeader({ alg: 'HS256', kid: cloudGlobal.kid })
          .sign(secret);
      },
    ],
  ])('is 401 for %s', async (_what, token) => {
    const response = await app.request('/api/me', { headers: bearer(await token()) });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(await response.json()).toEqual({ error: 'invalid_token' });
  });

  it('is 401 for credentials that are not one token', async () => {
    const token = await mint();
    for (const authorization of ['Bearer', `Bearer ${token} ${token}`, `Bearer ${token},x`]) {
      const response = await app.request('/api/me', { headers: { authorization } });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'invalid_token' });
    }
  });
});

describe('a token for a workspace in another region', () => {
  it('is refused with 421, naming the region this cell serves', async () => {
    const response = await app.request('/api/me', {
      headers: bearer(await mint({ region: 'us' })),
    });
    expect(response.status).toBe(421);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(await response.json()).toEqual({ error: 'wrong_region', region: 'eu' });
  });

  it('is judged only once it is a good token: a bad one is 401 whatever its region says', async () => {
    for (const token of [
      await sign(claims({ region: 'us' }), stranger),
      await mint({ region: 'us', issuedAt: nowSeconds() - 3600 }),
    ]) {
      expect((await app.request('/api/me', { headers: bearer(token) })).status).toBe(401);
    }
  });

  it("is the other cell's to take", async () => {
    const us = await openCell({ ...config, region: 'us' });
    const usToken = await mint({ region: 'us' });
    const response = await us.app.request('/api/me', { headers: bearer(usToken) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ region: 'us' });
    expect((await us.app.request('/api/me', { headers: bearer(await mint()) })).status).toBe(421);
    await us.close();
  });
});

/** A stand-in for cloud-global's key route, on a port of its own. */
async function serveKeys(answer: () => { status: number; body: string }) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const { status, body } =
      request.url === CELL_TOKEN_KEYS_PATH ? answer() : { status: 404, body: '{}' };
    response.writeHead(status, { 'content-type': 'application/json' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A cell whose CLOUD_GLOBAL_URL is `cloudGlobalUrl`, read from its environment as main.ts does. */
const cellFetchingKeysFrom = (cloudGlobalUrl: string) =>
  openCell(
    loadConfig({ DATABASE_URL: 'pglite:memory', REGION: 'eu', CLOUD_GLOBAL_URL: cloudGlobalUrl }),
    'remote',
  );

describe('the keys', () => {
  it("are fetched from cloud-global's key set at CLOUD_GLOBAL_URL", async () => {
    const global = await serveKeys(() => ({ status: 200, body: JSON.stringify(published) }));
    const cell = await cellFetchingKeysFrom(global.url);

    const response = await cell.app.request('/api/me', { headers: bearer(await mint()) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ personId: 'person-1', workspaceId: 'acme' });
    // Kept, not fetched for every request.
    await cell.app.request('/api/me', { headers: bearer(await mint()) });
    expect(global.requests).toEqual([`GET ${CELL_TOKEN_KEYS_PATH}`]);

    await cell.close();
    await global.close();
  });

  it('refuse a token signed by a key the set does not hold, once the set answers', async () => {
    const global = await serveKeys(() => ({ status: 200, body: JSON.stringify(published) }));
    const cell = await cellFetchingKeysFrom(global.url);

    const response = await cell.app.request('/api/me', {
      headers: bearer(await sign(claims(), stranger)),
    });
    expect(response.status).toBe(401);

    await cell.close();
    await global.close();
  });

  it('that cannot be fetched refuse every token with 503, saying nothing of why', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = await serveKeys(() => ({ status: 500, body: '{"error":"internal"}' }));
    const gone = await serveKeys(() => ({ status: 200, body: JSON.stringify(published) }));
    await gone.close();

    for (const global of [failing, gone]) {
      const cell = await cellFetchingKeysFrom(global.url);
      const token = await mint();
      const response = await cell.app.request('/api/me', { headers: bearer(token) });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'token_check_unavailable' });
      // The operator hears why; nobody hears the token.
      expect(logged).toHaveBeenCalledWith(
        expect.stringMatching(/^The cell could not get cloud-global's cell token keys: /),
      );
      expect(logged.mock.calls.flat().join('\n')).not.toContain(token);
      await cell.close();
    }
    await failing.close();
  });

  it('are not needed to refuse a request without a token', async () => {
    const gone = await serveKeys(() => ({ status: 200, body: JSON.stringify(published) }));
    await gone.close();
    const cell = await cellFetchingKeysFrom(gone.url);
    expect((await cell.app.request('/api/me')).status).toBe(401);
    await cell.close();
  });
});

describe('every route', () => {
  it('but GET /api/health refuses a request without a token', async () => {
    const routes = app.routes.filter((route) => route.method !== 'ALL');
    expect(routes.length).toBeGreaterThan(1);
    for (const { method, path } of routes) {
      const response = await app.request(path.replace(/:[^/]+/g, 'x'), { method });
      const open = method === 'GET' && path === '/api/health';
      expect([`${method} ${path}`, response.status]).toEqual([
        `${method} ${path}`,
        open ? 200 : 401,
      ]);
    }
  });

  it('that does not exist is 401 without a token, and 404 only with one', async () => {
    for (const path of ['/', '/api/runs', '/api/workspaces/sprocket']) {
      expect((await app.request(path)).status).toBe(401);
      expect((await app.request(path, { headers: bearer(await mint()) })).status).toBe(404);
    }
  });

  it('takes no workspace from its path', () => {
    const parameters = app.routes.flatMap(({ path }) =>
      [...path.matchAll(/:([^/{]+)/g)].map((match) => match[1] ?? ''),
    );
    expect(parameters.filter((name) => /workspace|^ws$/i.test(name))).toEqual([]);
  });
});

describe("a workspace's rows", () => {
  it('are read only with a token for that workspace, whatever the request names', async () => {
    // The cell has no tables yet, so this one is made for this test alone.
    await db.execute(sql`create table note (workspace_id text not null, body text not null)`);
    await db.execute(
      sql`insert into note values ('acme', 'Acme plan'), ('sprocket', 'Sprocket plan')`,
    );

    // A route added the way the cell's routes are: behind the check, scoped by its caller.
    const notes = new Hono<CellEnv>();
    notes.get('/', async (c) => {
      const result = (await db.execute(
        sql`select body from note where workspace_id = ${c.var.caller.workspaceId}`,
      )) as unknown as { rows: { body: string }[] };
      return c.json(result.rows.map((row) => row.body));
    });
    app.route('/api/notes', notes);

    // Sprocket named every way a request could name it, with Acme's token.
    const acme = await mint({ workspaceId: 'acme' });
    for (const path of [
      '/api/notes',
      '/api/notes?workspaceId=sprocket',
      '/api/notes?ws=sprocket',
    ]) {
      const response = await app.request(path, {
        headers: { ...bearer(acme), 'x-workspace-id': 'sprocket' },
      });
      expect(await response.json()).toEqual(['Acme plan']);
    }
    const sprocket = await mint({ workspaceId: 'sprocket' });
    expect(await (await app.request('/api/notes', { headers: bearer(sprocket) })).json()).toEqual([
      'Sprocket plan',
    ]);
    expect((await app.request('/api/notes')).status).toBe(401);
  });
});
