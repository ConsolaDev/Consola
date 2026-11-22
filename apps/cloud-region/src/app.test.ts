import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_KEYS_PATH,
  CELL_TOKEN_LIFETIME_SECONDS,
  type CellTokenGrant,
  cellTokenClaims,
  OUTBOX_ANSWER,
  OUTBOX_DELIVERY_MEDIA_TYPE,
  OUTBOX_DELIVERY_PATH,
  OUTBOX_MESSAGE_TYPE,
  type OutboxMessage,
  readOutOfOrderAnswer,
  WORKSPACE_ROLES,
  type WorkspaceChange,
} from '@consola/cloud-contract';
import {
  type CellMessage,
  PASS_AUDIENCE,
  PASS_MAX_LIFETIME_SECONDS,
  PASS_TYPE,
  readCellMessage,
  readPassClaims,
} from '@consola/runner-protocol';
import { asc, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  type CompactJWSHeaderParameters,
  CompactSign,
  calculateJwkThumbprint,
  compactVerify,
  createLocalJWKSet,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  type JWTHeaderParameters,
  importJWK,
  SignJWT,
} from 'jose';
import WebSocket from 'ws';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import type { CellEnv } from './adapters/http/caller.js';
import { type Database, migrateDatabase, openDatabase } from './adapters/persistence/database.js';
import { cloudSessions, workspaceMembers, workspaces } from './adapters/persistence/tables.js';
import { composeCell } from './compose.js';
import { type CellConfig, loadConfig } from './config.js';

const config: CellConfig = {
  databaseUrl: 'pglite:memory',
  region: 'eu',
  port: 3101,
  // Never fetched here: every cell below is handed a key set of its own, but the ones in "the
  // keys", which start a cloud-global of their own.
  cloudGlobalUrl: 'http://127.0.0.1:3100',
  // No runner: the cell starts without one, and "a runner and its passes" sets one.
  runner: null,
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
  const { app, injectWebSocket, closeRunnerSockets } = await composeCell({
    db: opened.db,
    config: cellConfig,
    cellTokenKeys,
  });
  return {
    app,
    injectWebSocket,
    db: opened.db,
    close: async () => {
      closeRunnerSockets();
      await opened.close();
    },
  };
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

/**
 * The routes that answer without a cell token, and what each answers a bare request: the health
 * check, the outbox's deliveries, which carry a signature instead (a bare one has none, and no
 * body, so it is unreadable), and the runner's socket, which carries the runner's secret instead.
 * Nothing else is open.
 */
const OPEN_ROUTES: Record<string, number> = {
  'GET /api/health': 200,
  [`POST ${OUTBOX_DELIVERY_PATH}`]: OUTBOX_ANSWER.unreadable,
  // The runner's socket, behind its shared secret instead, which a bare request does not carry.
  'GET /api/runner': 401,
};

describe('every route', () => {
  it('but the open ones refuses a request without a token', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Every route Hono holds but the check itself, which it lists as `ALL /*`.
    const routes = app.routes.filter((route) => !(route.method === 'ALL' && route.path === '/*'));
    expect(routes.length).toBeGreaterThan(2);
    for (const { method, path } of routes) {
      const response = await app.request(path.replace(/:[^/]+/g, 'x'), {
        method: method === 'ALL' ? 'GET' : method,
      });
      const route = `${method} ${path}`;
      expect([route, response.status]).toEqual([route, OPEN_ROUTES[route] ?? 401]);
    }
    // Each open route is one the app has.
    const held = new Set(routes.map(({ method, path }) => `${method} ${path}`));
    expect(Object.keys(OPEN_ROUTES).filter((route) => !held.has(route))).toEqual([]);
  });

  it('opens the outbox path to deliveries alone: any other method needs a token', async () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const response = await app.request(OUTBOX_DELIVERY_PATH, { method });
      expect([method, response.status]).toEqual([method, 401]);
      expect(await response.json()).toEqual({ error: 'token_required' });
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

// Outbox deliveries are signed here the way cloud-global signs them: the message's JSON as the
// payload of a compact JWS, with the cell token's key, its kid and the outbox's typ.

const outboxMessage = (
  sequence: number,
  change: WorkspaceChange,
  overrides: Partial<OutboxMessage> = {},
): OutboxMessage => ({ workspaceId: 'acme', region: 'eu', sequence, change, ...overrides });

const created = (overrides: Partial<OutboxMessage> = {}) =>
  outboxMessage(1, { type: 'workspace.created' }, overrides);

const added = (sequence: number, personId: string, role: CellTokenGrant['role']) =>
  outboxMessage(sequence, { type: 'member.added', personId, role });

function signDelivery(
  payload: unknown,
  key: SigningKey = cloudGlobal,
  header: Partial<CompactJWSHeaderParameters> = {},
): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({
      alg: CELL_TOKEN_ALGORITHM,
      kid: key.kid,
      typ: OUTBOX_MESSAGE_TYPE,
      ...header,
    })
    .sign(key.privateKey);
}

/** POSTs `body` to the outbox route of `cell` (this test's cell unless given), as cloud-global does. */
function postDelivery(
  body: string,
  options: { contentType?: string | null; cell?: Hono; headers?: Record<string, string> } = {},
) {
  const { contentType = OUTBOX_DELIVERY_MEDIA_TYPE, cell = app } = options;
  const headers: Record<string, string> = { ...options.headers };
  if (contentType !== null) headers['content-type'] = contentType;
  return cell.request(OUTBOX_DELIVERY_PATH, { method: 'POST', body, headers });
}

/** Signs `message` as cloud-global does and delivers it. */
const deliver = async (message: unknown) => postDelivery(await signDelivery(message));

/** Every row of the cell's copy, in a fixed order. */
async function copy() {
  return {
    workspaces: await db.select().from(workspaces).orderBy(asc(workspaces.workspaceId)),
    members: await db
      .select()
      .from(workspaceMembers)
      .orderBy(asc(workspaceMembers.workspaceId), asc(workspaceMembers.personId)),
  };
}

const empty = { workspaces: [], members: [] };

describe('POST /api/outbox', () => {
  let logged: MockInstance<typeof console.error>;
  beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it("applies a workspace's messages in order, leaving its copy: ids and roles", async () => {
    for (const message of [
      created(),
      added(2, 'person-dana', 'owner'),
      added(3, 'person-eli', 'member'),
      outboxMessage(4, { type: 'member.role-changed', personId: 'person-eli', role: 'admin' }),
      added(5, 'person-fay', 'member'),
      outboxMessage(6, { type: 'member.removed', personId: 'person-fay' }),
    ]) {
      const response = await deliver(message);
      expect([message.sequence, response.status]).toEqual([message.sequence, 200]);
      expect(await response.json()).toEqual({ applied: true });
    }
    expect(await copy()).toEqual({
      workspaces: [{ workspaceId: 'acme', lastAppliedSequence: 6 }],
      members: [
        { workspaceId: 'acme', personId: 'person-dana', role: 'owner' },
        { workspaceId: 'acme', personId: 'person-eli', role: 'admin' },
      ],
    });
    expect(logged).not.toHaveBeenCalled();
  });

  it('needs no cell token, and reads none it is sent', async () => {
    const response = await postDelivery(await signDelivery(created()), {
      headers: bearer('forged'),
    });
    expect(response.status).toBe(200);
  });

  it('changes nothing the second time it gets a message, answering that it has it', async () => {
    await deliver(created());
    await deliver(added(2, 'person-dana', 'owner'));
    const changed = outboxMessage(3, {
      type: 'member.role-changed',
      personId: 'person-dana',
      role: 'member',
    });
    const delivery = await signDelivery(changed);
    expect((await postDelivery(delivery)).status).toBe(200);
    const before = await copy();

    // The same delivery again, and earlier ones that would undo it if they were applied.
    for (const again of [delivery, await signDelivery(added(2, 'person-dana', 'owner'))]) {
      const response = await postDelivery(again);
      expect(response.status).toBe(OUTBOX_ANSWER.applied);
      expect(await response.json()).toEqual({ applied: true });
    }
    expect(await copy()).toEqual(before);
    expect(before.members).toEqual([
      { workspaceId: 'acme', personId: 'person-dana', role: 'member' },
    ]);
  });

  it('applies a message delivered many times at once exactly once', async () => {
    const first = await signDelivery(created());
    const firsts = await Promise.all(Array.from({ length: 6 }, () => postDelivery(first)));
    expect(firsts.map((response) => response.status)).toEqual(Array(6).fill(200));
    const second = await signDelivery(added(2, 'person-dana', 'owner'));
    const seconds = await Promise.all(Array.from({ length: 6 }, () => postDelivery(second)));
    expect(seconds.map((response) => response.status)).toEqual(Array(6).fill(200));
    expect(await copy()).toEqual({
      workspaces: [{ workspaceId: 'acme', lastAppliedSequence: 2 }],
      members: [{ workspaceId: 'acme', personId: 'person-dana', role: 'owner' }],
    });
  });

  it('answers 409 across a gap, naming the next sequence the way the contract reads it', async () => {
    await deliver(created());
    await deliver(added(2, 'person-dana', 'owner'));
    const before = await copy();
    const response = await deliver(outboxMessage(4, { type: 'member.removed', personId: 'x' }));
    expect(response.status).toBe(OUTBOX_ANSWER.outOfOrder);
    const body = await response.json();
    expect(body).toEqual({ nextSequence: 3 });
    expect(readOutOfOrderAnswer(body)).toEqual({ ok: true, value: { nextSequence: 3 } });
    expect(await copy()).toEqual(before);
    expect(logged).toHaveBeenCalledWith(
      'The cell refused outbox message 4 of workspace acme: it applies 3 next.',
    );
  });

  it('answers 409 naming the first sequence for a workspace it holds nothing of', async () => {
    const response = await deliver(added(2, 'person-dana', 'owner'));
    expect(response.status).toBe(OUTBOX_ANSWER.outOfOrder);
    expect(await response.json()).toEqual({ nextSequence: 1 });
    expect(await copy()).toEqual(empty);
  });

  it("refuses a message about another region's workspace with 421, applying nothing", async () => {
    const response = await deliver(created({ workspaceId: 'sprocket', region: 'us' }));
    expect(response.status).toBe(OUTBOX_ANSWER.otherRegion);
    expect(await response.json()).toEqual({ error: 'otherRegion', region: 'eu' });
    expect(await copy()).toEqual(empty);
    expect(logged).toHaveBeenCalledWith(
      'The cell refused outbox message 1 of workspace sprocket: the workspace is in us, and this cell serves eu.',
    );
  });

  it("is the other cell's to apply", async () => {
    const us = await openCell({ ...config, region: 'us' });
    const sprocket = await signDelivery(created({ workspaceId: 'sprocket', region: 'us' }));
    expect((await postDelivery(sprocket, { cell: us.app })).status).toBe(200);
    expect((await postDelivery(await signDelivery(created()), { cell: us.app })).status).toBe(421);
    await us.close();
  });

  it.each<[string, () => Promise<string>]>([
    [
      "one signed by another key that names cloud-global's key",
      () => signDelivery(created(), stranger, { kid: cloudGlobal.kid }),
    ],
    ['one signed by a key cloud-global does not publish', () => signDelivery(created(), stranger)],
    [
      'one whose payload was changed after signing',
      async () => {
        const [header, , signature] = (await signDelivery(created())).split('.');
        return [header, base64url(created({ workspaceId: 'sprocket' })), signature].join('.');
      },
    ],
    ['one with another typ', () => signDelivery(created(), cloudGlobal, { typ: 'JWT' })],
    ['one with no typ', () => signDelivery(created(), cloudGlobal, { typ: undefined })],
    ['a real cell token', () => mint()],
    ['one naming no key', () => signDelivery(created(), cloudGlobal, { kid: undefined })],
    [
      "an HS256 one whose secret is cloud-global's public key",
      async () => {
        const secret = new TextEncoder().encode(await exportSPKI(cloudGlobal.publicKey));
        return new CompactSign(new TextEncoder().encode(JSON.stringify(created())))
          .setProtectedHeader({ alg: 'HS256', kid: cloudGlobal.kid, typ: OUTBOX_MESSAGE_TYPE })
          .sign(secret);
      },
    ],
    [
      'an unsigned one (alg: none)',
      async () =>
        `${base64url({ alg: 'none', kid: cloudGlobal.kid, typ: OUTBOX_MESSAGE_TYPE })}.${base64url(created())}.`,
    ],
    ['the message, unsigned', async () => JSON.stringify(created())],
    ['an empty body', async () => ''],
  ])('refuses %s with 401, applying nothing', async (_what, delivery) => {
    const body = await delivery();
    const response = await postDelivery(body);
    expect(response.status).toBe(OUTBOX_ANSWER.unsigned);
    expect(await response.json()).toEqual({ error: 'unsigned' });
    expect(await copy()).toEqual(empty);
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(
        /^The cell refused an outbox delivery: it is not signed by cloud-global/,
      ),
    );
    if (body !== '') expect(logged.mock.calls.flat().join('\n')).not.toContain(body);
  });

  it('refuses a body not sent as application/jose with 400, before reading it', async () => {
    const delivery = await signDelivery(created());
    for (const contentType of ['application/json', 'text/plain', 'application/jose+json', null]) {
      const response = await postDelivery(delivery, { contentType });
      expect([contentType, response.status]).toEqual([contentType, OUTBOX_ANSWER.unreadable]);
      expect(await response.json()).toEqual({ error: 'unreadable' });
    }
    expect(await copy()).toEqual(empty);
    expect(logged).toHaveBeenCalledWith(
      'The cell refused an outbox delivery: it was not sent as application/jose.',
    );
    // The media type's case and its parameters do not matter.
    const response = await postDelivery(delivery, {
      contentType: 'Application/JOSE; charset=utf-8',
    });
    expect(response.status).toBe(200);
  });

  it('refuses a signed message the contract does not read with 400, logging why but not the body', async () => {
    for (const [message, reason] of [
      [
        { ...created(), email: 'dana@acme.test' },
        'the message has `email`, which the contract does not name',
      ],
      [
        outboxMessage(1, { type: 'member.removed', personId: 'person-dana' }),
        "a workspace's first message is not its `workspace.created`",
      ],
      [
        { ...added(2, 'person-dana', 'owner'), sequence: 0 },
        '`sequence` is not a whole number from 1',
      ],
      ['acme', 'the message is not an object'],
    ] as const) {
      const delivery = await signDelivery(message);
      const response = await postDelivery(delivery);
      expect(response.status).toBe(OUTBOX_ANSWER.unreadable);
      expect(await response.json()).toEqual({ error: 'unreadable' });
      expect(logged).toHaveBeenLastCalledWith(
        `The cell refused an outbox delivery: its message does not read (${reason}).`,
      );
    }
    expect(logged.mock.calls.flat().join('\n')).not.toContain('dana@acme.test');
    expect(await copy()).toEqual(empty);
  });

  it('refuses a body too large for a message with 400, before checking it', async () => {
    const delivery = await signDelivery({ ...created(), padding: 'x'.repeat(20_000) });
    const response = await postDelivery(delivery);
    expect(response.status).toBe(OUTBOX_ANSWER.unreadable);
    expect(await response.json()).toEqual({ error: 'unreadable' });
    expect(logged).toHaveBeenCalledWith(
      'The cell refused an outbox delivery: its body is over 16384 bytes.',
    );
    // Nor when it says so in its Content-Length.
    const declared = await postDelivery(delivery, {
      headers: { 'content-length': String(delivery.length) },
    });
    expect(declared.status).toBe(OUTBOX_ANSWER.unreadable);
  });

  it('answers 503 when the database does not, applying nothing', async () => {
    const delivery = await signDelivery(created());
    await closeDatabase();
    const response = await postDelivery(delivery);
    expect(response.status).toBe(OUTBOX_ANSWER.unavailable);
    expect(await response.json()).toEqual({ error: 'unavailable' });
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(/^The cell could not apply outbox message 1 of workspace acme: /),
    );
  });
});

describe('the outbox and the keys', () => {
  it("are checked with cloud-global's key set, fetched once for tokens and deliveries", async () => {
    const global = await serveKeys(() => ({ status: 200, body: JSON.stringify(published) }));
    const cell = await cellFetchingKeysFrom(global.url);

    const delivery = await signDelivery(created());
    expect((await postDelivery(delivery, { cell: cell.app })).status).toBe(200);
    expect((await cell.app.request('/api/me', { headers: bearer(await mint()) })).status).toBe(200);
    expect(global.requests).toEqual([`GET ${CELL_TOKEN_KEYS_PATH}`]);

    await cell.close();
    await global.close();
  });

  it('that cannot be fetched refuse every delivery with 503, never 401, saying why', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = await serveKeys(() => ({ status: 500, body: '{"error":"internal"}' }));
    const gone = await serveKeys(() => ({ status: 200, body: JSON.stringify(published) }));
    await gone.close();

    for (const global of [failing, gone]) {
      const cell = await cellFetchingKeysFrom(global.url);
      const delivery = await signDelivery(created());
      const response = await postDelivery(delivery, { cell: cell.app });
      expect(response.status).toBe(OUTBOX_ANSWER.unavailable);
      expect(await response.json()).toEqual({ error: 'unavailable' });
      expect(logged).toHaveBeenCalledWith(
        expect.stringMatching(/^The cell could not get cloud-global's cell token keys: /),
      );
      expect(logged.mock.calls.flat().join('\n')).not.toContain(delivery);
      await cell.close();
    }
    await failing.close();
  });
});

describe('a delivery sent as a cell token', () => {
  it('is no token: /api/me refuses it', async () => {
    const delivery = await signDelivery(created());
    const response = await app.request('/api/me', { headers: bearer(delivery) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_token' });
  });

  it('is no token even when its payload holds good cell token claims', async () => {
    // Signed with cloud-global's key and the outbox's typ: the typ alone refuses it.
    const delivery = await signDelivery(claims());
    const response = await app.request('/api/me', { headers: bearer(delivery) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_token' });
  });
});

describe('cloud sessions, with no runner connected (until the runner socket exists)', () => {
  const json = async (token: string, path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { ...bearer(token), 'content-type': 'application/json' },
    });

  it('answers 503 {"error":"no_runner"} to a start and records nothing', async () => {
    const token = await mint();
    const response = await json(token, '/api/cloud-sessions', {
      method: 'POST',
      body: JSON.stringify({ repository: 'sprocket/catalog-portal', harness: 'claude' }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"no_runner"}');
    expect(await db.select().from(cloudSessions)).toEqual([]);
  });

  it('answers 503 no_runner to the options', async () => {
    const response = await json(await mint(), '/api/cloud-sessions/options');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'no_runner' });
  });

  it('lists none, and holds no session by any id', async () => {
    const token = await mint();
    expect(await (await json(token, '/api/cloud-sessions')).json()).toEqual([]);
    expect((await json(token, '/api/cloud-sessions/session-1')).status).toBe(404);
    expect(
      (await json(token, '/api/cloud-sessions/session-1/stop', { method: 'POST' })).status,
    ).toBe(404);
  });

  it('needs a token', async () => {
    expect((await app.request('/api/cloud-sessions')).status).toBe(401);
    expect((await app.request('/api/cloud-sessions', { method: 'POST' })).status).toBe(401);
  });
});

describe('a runner and its passes', () => {
  // Stand-ins, never real credentials.
  const RUNNER_SECRET = 'sprocket-runner-secret-0123456789abcdef';
  const passJwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as Record<
    string,
    unknown
  >;
  const runnerConfig: CellConfig = {
    ...config,
    runner: { secret: RUNNER_SECRET, workspaceId: 'acme', passPrivateKey: passJwk },
  };

  /** Every line the cell writes to the console while a test runs. */
  function captureLogs(): () => string {
    const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    return () => spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n');
  }

  const held = (id: string, status: 'starting' | 'running', personId = 'person-1') => ({
    id,
    workspaceId: 'acme',
    personId,
    repository: 'sprocket/catalog-portal',
    harness: 'claude',
    status,
    title: null,
    hostUrl: status === 'running' ? 'https://3000-sandbox.e2b.example' : null,
    error: null,
    errorCode: null,
    runnerId: 'runner-1',
    createdAt: nowSeconds(),
    endedAt: null,
  });

  it('refuses a cell that has a runner but a pass key that is no Ed25519 key, at compose', async () => {
    const opened = openDatabase('pglite:memory');
    const x25519 = generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
    await expect(
      composeCell({
        db: opened.db,
        config: { ...runnerConfig, runner: { ...runnerConfig.runner!, passPrivateKey: x25519 } },
        cellTokenKeys: createLocalJWKSet(published),
      }),
    ).rejects.toThrow(/^The configuration is not valid:\n {2}- PASS_PRIVATE_KEY: /);
    await opened.close();
  });

  it("signs a pass for the caller's running session, which the derived key verifies", async () => {
    const logs = captureLogs();
    const cell = await openCell(runnerConfig);
    await cell.db.insert(cloudSessions).values(held('session-1', 'running'));

    const response = await cell.app.request('/api/cloud-sessions/session-1/pass', {
      method: 'POST',
      headers: bearer(await mint()),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { pass: string; hostUrl: string; expiresAt: number };
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'hostUrl', 'pass']);
    expect(body.hostUrl).toBe('https://3000-sandbox.e2b.example');
    expect(Number.isInteger(body.expiresAt)).toBe(true);

    // EdDSA only, against the public half of PASS_PRIVATE_KEY, as the session's host checks it.
    const publicKey = await importJWK(
      { kty: 'OKP', crv: 'Ed25519', x: passJwk.x as string },
      'EdDSA',
    );
    const verified = await compactVerify(body.pass, publicKey, { algorithms: ['EdDSA'] });
    expect(verified.protectedHeader).toEqual({ alg: 'EdDSA', typ: PASS_TYPE });
    const claims = readPassClaims(JSON.parse(new TextDecoder().decode(verified.payload)));
    if (!claims.ok) throw new Error(claims.reason);
    expect(claims.value).toMatchObject({
      aud: PASS_AUDIENCE,
      sub: 'person-1',
      ws: 'acme',
      sid: 'session-1',
    });
    expect(claims.value.exp - claims.value.iat).toBe(PASS_MAX_LIFETIME_SECONDS);
    expect(body.expiresAt).toBe(claims.value.exp);

    // Nothing the cell logged holds the pass or the key that signs it.
    expect(logs()).not.toContain(body.pass);
    expect(logs()).not.toContain(String(passJwk.d));
    await cell.close();
  });

  it("is 404 not_found for a starting session, another person's, or an unknown id", async () => {
    const logs = captureLogs();
    const cell = await openCell(runnerConfig);
    await cell.db
      .insert(cloudSessions)
      .values([held('session-1', 'starting'), held('session-2', 'running', 'person-2')]);
    const token = await mint();

    for (const id of ['session-1', 'session-2', 'nope']) {
      const response = await cell.app.request(`/api/cloud-sessions/${id}/pass`, {
        method: 'POST',
        headers: bearer(token),
      });
      expect([id, response.status]).toEqual([id, 404]);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
    expect(logs()).not.toContain(String(passJwk.d));
    await cell.close();
  });

  it('is 503 no_runner on a cell with no runner, and so no pass key', async () => {
    await db.insert(cloudSessions).values(held('session-1', 'running'));
    const response = await app.request('/api/cloud-sessions/session-1/pass', {
      method: 'POST',
      headers: bearer(await mint()),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'no_runner' });
  });

  it("starts a session on the runner's socket, wired as main.ts wires it", async () => {
    const logs = captureLogs();
    const cell = await openCell(runnerConfig);
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const started = serve({ fetch: cell.app.fetch, hostname: '127.0.0.1', port: 0 }, () =>
        resolve(started),
      );
      cell.injectWebSocket(started);
    });
    const port = (server.address() as AddressInfo).port;

    // A bare upgrade, and one with a cell token in place of the secret, are refused.
    for (const headers of [{}, bearer(await mint())]) {
      const refused = new WebSocket(`ws://127.0.0.1:${port}/api/runner`, { headers });
      // Ending a refused socket, still connecting, is an error the test expects.
      refused.on('error', () => {});
      const status = await new Promise<number>((resolve) =>
        refused.once('unexpected-response', (_request, response) =>
          resolve(response.statusCode ?? 0),
        ),
      );
      expect(status).toBe(401);
      refused.terminate();
    }

    const received: CellMessage[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/runner`, {
      headers: { authorization: `Bearer ${RUNNER_SECRET}` },
    });
    socket.on('message', (data) => {
      const read = readCellMessage(JSON.parse(String(data)));
      if (read.ok) received.push(read.value);
    });
    await new Promise((resolve) => socket.once('open', resolve));
    socket.send(
      JSON.stringify({
        type: 'hello',
        runnerId: 'runner-1',
        repositories: ['sprocket/catalog-portal'],
        harnesses: ['claude'],
        runningSessionIds: [],
        endedSessions: [],
      }),
    );
    const token = await mint();
    await vi.waitFor(async () => {
      const options = await cell.app.request('/api/cloud-sessions/options', {
        headers: bearer(token),
      });
      expect(options.status).toBe(200);
    });

    const started = await cell.app.request('/api/cloud-sessions', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ repository: 'sprocket/catalog-portal', harness: 'claude' }),
    });
    expect(started.status).toBe(201);
    const session = (await started.json()) as { id: string; status: string };
    expect(session.status).toBe('starting');
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      type: 'session.start',
      sessionId: session.id,
      workspaceId: 'acme',
      passPublicKeyPem: expect.stringMatching(/^-----BEGIN PUBLIC KEY-----/),
    });

    // The runner reports the session running, and its person gets a pass for it.
    socket.send(
      JSON.stringify({
        type: 'session.update',
        sessionId: session.id,
        status: 'running',
        hostUrl: 'https://3000-sandbox.e2b.example',
      }),
    );
    await vi.waitFor(async () => {
      const pass = await cell.app.request(`/api/cloud-sessions/${session.id}/pass`, {
        method: 'POST',
        headers: bearer(token),
      });
      expect(pass.status).toBe(200);
    });

    expect(logs()).not.toContain(RUNNER_SECRET);
    expect(logs()).not.toContain(String(passJwk.d));
    socket.terminate();
    await cell.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
