import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { asc, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  type CompactJWSHeaderParameters,
  CompactSign,
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
import type { ZodType } from 'zod';
import type { CellEnv } from './adapters/http/caller.js';
import {
  deleteTeam,
  deleteTeamMember,
  getFactory,
  getFactoryVersion,
  listFactories,
  listTeams,
  patchFactory,
  patchTeam,
  postFactory,
  postFactoryVersion,
  postTeam,
  putTeamMember,
  type ROUTES,
} from './adapters/http/contract.js';
import { type Database, migrateDatabase, openDatabase } from './adapters/persistence/database.js';
import { workspaceMembers, workspaces } from './adapters/persistence/tables.js';
import { composeCell } from './compose.js';
import { type CellConfig, loadConfig } from './config.js';
import { FIRST_TEAM_NAME } from './domain/team.js';

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

type CellApp = ReturnType<typeof composeCell>['app'];
let app: CellApp;
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

/**
 * The routes that answer without a cell token, and what each answers a bare request: the health
 * check, and the outbox's deliveries, which carry a signature instead (a bare one has none, and
 * no body, so it is unreadable). Nothing else is open.
 */
const OPEN_ROUTES: Record<string, number> = {
  'GET /api/health': 200,
  [`POST ${OUTBOX_DELIVERY_PATH}`]: OUTBOX_ANSWER.unreadable,
};

describe('every route', () => {
  it('but the open ones refuses a request without a token', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Every route Hono holds but the check itself, which it lists as `ALL /*`: each once, though
    // Hono lists a route once per handler in its chain (its middleware and validators too).
    const listed = app.routes.filter((route) => !(route.method === 'ALL' && route.path === '/*'));
    const routes = [
      ...new Map(listed.map((route) => [`${route.method} ${route.path}`, route])).values(),
    ];
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
  options: { contentType?: string | null; cell?: CellApp; headers?: Record<string, string> } = {},
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

type ContractRoute = (typeof ROUTES)[number];
type DeclaredAnswer = { content?: Record<string, { schema: ZodType }> };

/**
 * The body of `response`, read with the schema `route` declares for its status: a status the
 * contract does not name, or a body with a field its strict schema does not, fails the test.
 */
async function answerOf(route: ContractRoute, response: Response): Promise<unknown> {
  const declared = (route.responses as Record<number, DeclaredAnswer>)[response.status];
  expect(declared, `${route.method} ${route.path} declares ${response.status}`).toBeDefined();
  const schema = declared?.content?.['application/json']?.schema;
  if (!schema) {
    expect(await response.text()).toBe('');
    return undefined;
  }
  return schema.parse(await response.json());
}

/** Asks `route` at `path` with a token for `who`, and reads its answer by the contract. */
async function ask(
  route: ContractRoute,
  path: string,
  who: Partial<CellTokenGrant>,
  init: { body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...bearer(await mint(who)), ...init.headers };
  let body: string | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    headers['content-type'] ??= 'application/json';
  }
  const response = await app.request(path, { method: route.method.toUpperCase(), headers, body });
  return { status: response.status, body: await answerOf(route, response) };
}

const owner = { personId: 'person-dana', role: 'owner' } as const;
const admin = { personId: 'person-eli', role: 'admin' } as const;
const member = { personId: 'person-fay', role: 'member' } as const;

/** Acme, delivered by the outbox as cloud-global would: Dana owns it, Eli admins it, Fay joined. */
async function acmeWithMembers() {
  for (const message of [
    created(),
    added(2, owner.personId, owner.role),
    added(3, admin.personId, admin.role),
    added(4, member.personId, member.role),
  ]) {
    expect((await deliver(message)).status).toBe(200);
  }
}

type TeamBody = { id: string; name: string; first: boolean; memberIds: string[] };

async function teamsSeenBy(who: Partial<CellTokenGrant>) {
  const answer = await ask(listTeams, '/api/teams', who);
  expect(answer.status).toBe(200);
  return answer.body as { teams: TeamBody[]; canManage: boolean };
}

async function makeTeam(name: string) {
  const answer = await ask(postTeam, '/api/teams', owner, { body: { name } });
  expect(answer.status).toBe(201);
  return answer.body as TeamBody;
}

describe('teams', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('start as one, the first team, which everyone who joins the workspace is in', async () => {
    await acmeWithMembers();
    expect(await teamsSeenBy(owner)).toEqual({
      teams: [
        {
          id: expect.any(String),
          name: FIRST_TEAM_NAME,
          first: true,
          memberIds: [owner.personId, admin.personId, member.personId],
        },
      ],
      canManage: true,
    });
  });

  it('are pending while the cell does not hold the workspace', async () => {
    const answer = await ask(listTeams, '/api/teams', owner);
    expect(answer).toEqual({ status: 409, body: { error: 'workspace_pending' } });
  });

  it('are made, renamed and deleted by owners and admins', async () => {
    await acmeWithMembers();
    const platform = await makeTeam('Platform');
    expect(platform).toEqual({
      id: expect.any(String),
      name: 'Platform',
      first: false,
      memberIds: [],
    });

    const renamed = await ask(patchTeam, `/api/teams/${platform.id}`, admin, {
      body: { name: 'Apps' },
    });
    expect(renamed).toEqual({ status: 200, body: { ...platform, name: 'Apps' } });

    expect(await ask(deleteTeam, `/api/teams/${platform.id}`, admin)).toEqual({
      status: 204,
      body: undefined,
    });
    expect((await teamsSeenBy(owner)).teams.map((team) => team.name)).toEqual([FIRST_TEAM_NAME]);
  });

  it('keep their names unique in the workspace, whatever their case', async () => {
    await acmeWithMembers();
    const platform = await makeTeam('Platform');
    await makeTeam('Apps');
    expect(await ask(postTeam, '/api/teams', owner, { body: { name: 'PLATFORM' } })).toEqual({
      status: 409,
      body: { error: 'name_taken' },
    });
    expect(
      await ask(patchTeam, `/api/teams/${platform.id}`, owner, { body: { name: 'apps' } }),
    ).toEqual({ status: 409, body: { error: 'name_taken' } });
  });

  it('keep the first team: it can be renamed, never deleted', async () => {
    await acmeWithMembers();
    const [first] = (await teamsSeenBy(owner)).teams;
    const path = `/api/teams/${first?.id}`;
    expect(await ask(deleteTeam, path, owner)).toEqual({
      status: 409,
      body: { error: 'first_team' },
    });
    expect((await ask(patchTeam, path, owner, { body: { name: 'Everyone' } })).body).toMatchObject({
      name: 'Everyone',
      first: true,
    });
  });

  it('name every problem with a name, and refuse a body that is not one', async () => {
    await acmeWithMembers();
    expect(await ask(postTeam, '/api/teams', owner, { body: { name: '  ' } })).toEqual({
      status: 400,
      body: { error: 'invalid_team', problems: ['name_missing'] },
    });
    expect(
      await ask(postTeam, '/api/teams', owner, { body: { name: `${'a'.repeat(65)}\n` } }),
    ).toEqual({ status: 400, body: { error: 'invalid_team', problems: ['name_too_long'] } });
    for (const body of [{}, { name: 7 }, [], 'not json']) {
      expect(await ask(postTeam, '/api/teams', owner, { body })).toEqual({
        status: 400,
        body: { error: 'invalid_request' },
      });
    }
    expect(
      await ask(postTeam, '/api/teams', owner, {
        body: JSON.stringify({ name: 'Platform' }),
        headers: { 'content-type': 'text/plain' },
      }),
    ).toEqual({ status: 415, body: { error: 'unsupported_media_type' } });
  });

  it('show a member only the teams they are in, with no way to change them', async () => {
    await acmeWithMembers();
    const platform = await makeTeam('Platform');
    const seen = await teamsSeenBy(member);
    expect(seen.canManage).toBe(false);
    expect(seen.teams.map((team) => team.name)).toEqual([FIRST_TEAM_NAME]);

    const refused = { status: 403, body: { error: 'not_allowed' } };
    const path = `/api/teams/${platform.id}`;
    expect(await ask(postTeam, '/api/teams', member, { body: { name: 'Mine' } })).toEqual(refused);
    expect(await ask(patchTeam, path, member, { body: { name: 'Mine' } })).toEqual(refused);
    expect(await ask(deleteTeam, path, member)).toEqual(refused);
    expect(await ask(putTeamMember, `${path}/members/${member.personId}`, member)).toEqual(refused);
    expect(await ask(deleteTeamMember, `${path}/members/${owner.personId}`, member)).toEqual(
      refused,
    );
  });

  it('refuse an admin demoted since their token was minted, as soon as the outbox says so', async () => {
    await acmeWithMembers();
    expect((await ask(postTeam, '/api/teams', admin, { body: { name: 'Apps' } })).status).toBe(201);
    const demoted = outboxMessage(5, {
      type: 'member.role-changed',
      personId: admin.personId,
      role: 'member',
    });
    expect((await deliver(demoted)).status).toBe(200);
    // The same token, still in date, still saying admin.
    expect(await ask(postTeam, '/api/teams', admin, { body: { name: 'Design' } })).toEqual({
      status: 403,
      body: { error: 'not_allowed' },
    });
    expect((await teamsSeenBy(admin)).canManage).toBe(false);
  });

  it("take only the workspace's members, and let them go", async () => {
    await acmeWithMembers();
    const platform = await makeTeam('Platform');
    const members = `/api/teams/${platform.id}/members`;

    expect(await ask(putTeamMember, `${members}/person-gus`, owner)).toEqual({
      status: 409,
      body: { error: 'not_a_workspace_member' },
    });
    expect(await ask(putTeamMember, `${members}/${member.personId}`, owner)).toEqual({
      status: 200,
      body: { ...platform, memberIds: [member.personId] },
    });
    // Twice changes nothing.
    expect((await ask(putTeamMember, `${members}/${member.personId}`, owner)).body).toEqual({
      ...platform,
      memberIds: [member.personId],
    });
    expect(await ask(deleteTeamMember, `${members}/${member.personId}`, owner)).toEqual({
      status: 200,
      body: platform,
    });
  });

  it('lose a member who leaves the workspace, from every team, as the outbox says so', async () => {
    await acmeWithMembers();
    const platform = await makeTeam('Platform');
    await ask(putTeamMember, `/api/teams/${platform.id}/members/${member.personId}`, owner);

    const removed = outboxMessage(5, { type: 'member.removed', personId: member.personId });
    expect((await deliver(removed)).status).toBe(200);
    expect((await teamsSeenBy(owner)).teams.map((team) => team.memberIds)).toEqual([
      [owner.personId, admin.personId],
      [],
    ]);
  });

  it("of another workspace are none of the caller's: not found, never changed", async () => {
    await acmeWithMembers();
    const platform = await makeTeam('Platform');
    // Sprocket, where Dana is an owner too.
    for (const message of [
      created({ workspaceId: 'sprocket' }),
      outboxMessage(2, { type: 'member.added', ...owner }, { workspaceId: 'sprocket' }),
    ]) {
      expect((await deliver(message)).status).toBe(200);
    }
    const stranger = { ...owner, workspaceId: 'sprocket' };
    const path = `/api/teams/${platform.id}`;
    const notFound = { status: 404, body: { error: 'team_not_found' } };

    expect(await ask(patchTeam, path, stranger, { body: { name: 'Mine' } })).toEqual(notFound);
    expect(await ask(deleteTeam, path, stranger)).toEqual(notFound);
    expect(await ask(putTeamMember, `${path}/members/${owner.personId}`, stranger)).toEqual(
      notFound,
    );
    expect((await teamsSeenBy(stranger)).teams.map((team) => team.name)).toEqual([FIRST_TEAM_NAME]);
    expect((await teamsSeenBy(owner)).teams.map((team) => team.name)).toEqual([
      FIRST_TEAM_NAME,
      'Platform',
    ]);
  });
});

type FactoryBody = {
  id: string;
  name: string;
  teamId: string;
  source: { kind: 'stored' };
  latestVersion: number;
  updatedAt: string;
};
type FileBody = { path: string; content: string };

async function makeFactory(name: string, teamId: string, who: Partial<CellTokenGrant> = owner) {
  const answer = await ask(postFactory, '/api/factories', who, { body: { name, teamId } });
  expect(answer.status).toBe(201);
  return answer.body as FactoryBody;
}

async function factoriesSeenBy(who: Partial<CellTokenGrant>) {
  const answer = await ask(listFactories, '/api/factories', who);
  expect(answer.status).toBe(200);
  return (answer.body as { factories: FactoryBody[] }).factories.map((factory) => factory.name);
}

const saveFiles = (
  factoryId: string,
  who: Partial<CellTokenGrant>,
  body: { baseVersion: number; files: FileBody[] },
) => ask(postFactoryVersion, `/api/factories/${factoryId}/versions`, who, { body });

const REVIEWER = '---\ndescription: Reviews pull requests.\n---\nYou review pull requests.\n';
const FILES: FileBody[] = [
  { path: 'factory.yml', content: 'version: 1\nautomations:\n' },
  { path: 'agents/reviewer.md', content: REVIEWER },
];

describe('factories', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  /** Acme's first team, which everyone is in. */
  async function general() {
    const [first] = (await teamsSeenBy(owner)).teams;
    if (!first) throw new Error('Acme has no first team');
    return first;
  }

  it('are made blank, naming the team that owns them, and read with their latest version', async () => {
    await acmeWithMembers();
    const team = await general();
    const deploys = await makeFactory('Deploys', team.id);
    expect(deploys).toEqual({
      id: expect.any(String),
      name: 'Deploys',
      teamId: team.id,
      source: { kind: 'stored' },
      latestVersion: 1,
      updatedAt: expect.any(String),
    });
    expect(await ask(getFactory, `/api/factories/${deploys.id}`, member)).toEqual({
      status: 200,
      body: {
        factory: deploys,
        version: {
          factoryId: deploys.id,
          version: 1,
          savedAt: deploys.updatedAt,
          savedBy: owner.personId,
          files: [],
        },
      },
    });
  });

  it('save files as a new version, read the latest, and keep every earlier one', async () => {
    await acmeWithMembers();
    const deploys = await makeFactory('Deploys', (await general()).id);

    const saved = await saveFiles(deploys.id, member, { baseVersion: 1, files: FILES });
    expect(saved).toEqual({
      status: 201,
      body: {
        version: {
          factoryId: deploys.id,
          version: 2,
          savedAt: expect.any(String),
          savedBy: member.personId,
          files: [FILES[1], FILES[0]],
        },
        notices: [],
      },
    });

    const latest = await ask(getFactory, `/api/factories/${deploys.id}`, admin);
    expect(latest.body).toMatchObject({
      factory: { latestVersion: 2 },
      version: { version: 2, files: [FILES[1], FILES[0]] },
    });
    const versions = `/api/factories/${deploys.id}/versions`;
    expect((await ask(getFactoryVersion, `${versions}/1`, admin)).body).toMatchObject({
      version: 1,
      files: [],
    });
    expect((await ask(getFactoryVersion, `${versions}/2`, admin)).body).toEqual(
      (saved.body as { version: unknown }).version,
    );
    expect(await ask(getFactoryVersion, `${versions}/3`, admin)).toEqual({
      status: 404,
      body: { error: 'version_not_found' },
    });
    for (const version of ['0', 'latest', '1.5', '01']) {
      expect(await ask(getFactoryVersion, `${versions}/${version}`, admin)).toEqual({
        status: 400,
        body: { error: 'invalid_request' },
      });
    }
  });

  it('refuse files that fail the factory schema, with the errors, and save nothing', async () => {
    await acmeWithMembers();
    const deploys = await makeFactory('Deploys', (await general()).id);
    const answer = await saveFiles(deploys.id, owner, {
      baseVersion: 1,
      files: [
        { path: 'factory.yml', content: 'version: 1\nautomations:\n  - name: x\n    bogus: 1\n' },
        { path: 'agents/reviewer.md', content: '---\ncolour: blue\n---\nYou review.\n' },
        { path: 'notes.txt', content: 'Remember the milk.' },
      ],
    });
    expect(answer.status).toBe(400);
    const { error, issues } = answer.body as {
      error: string;
      issues: { file?: string; line?: number; message: string }[];
    };
    expect(error).toBe('invalid_files');
    expect(issues).toContainEqual(
      expect.objectContaining({
        file: 'factory.yml',
        line: 4,
        message: 'Unrecognized key: "bogus"',
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        file: 'agents/reviewer.md',
        line: 2,
        message: 'Unrecognized key in an agent file: `colour`.',
      }),
    );
    expect(issues).toContainEqual(expect.objectContaining({ file: 'notes.txt' }));
    expect((await ask(getFactory, `/api/factories/${deploys.id}`, owner)).body).toMatchObject({
      factory: { latestVersion: 1 },
    });
  });

  it('are hidden from a member outside their team, and seen by an admin', async () => {
    await acmeWithMembers();
    const platform = await makeTeam('Platform');
    const deploys = await makeFactory('Deploys', platform.id);
    await makeFactory('Reviews', (await general()).id);

    expect(await factoriesSeenBy(member)).toEqual(['Reviews']);
    const notFound = { status: 404, body: { error: 'factory_not_found' } };
    expect(await ask(getFactory, `/api/factories/${deploys.id}`, member)).toEqual(notFound);
    expect(await ask(getFactoryVersion, `/api/factories/${deploys.id}/versions/1`, member)).toEqual(
      notFound,
    );
    expect(await saveFiles(deploys.id, member, { baseVersion: 1, files: FILES })).toEqual(notFound);

    expect(await factoriesSeenBy(admin)).toEqual(['Deploys', 'Reviews']);
    expect((await ask(getFactory, `/api/factories/${deploys.id}`, admin)).status).toBe(200);

    // Once in Platform, the member sees its factory.
    await ask(putTeamMember, `/api/teams/${platform.id}/members/${member.personId}`, owner);
    expect(await factoriesSeenBy(member)).toEqual(['Deploys', 'Reviews']);
  });

  it('are made only for a team the caller sees, with a name unique in the workspace', async () => {
    await acmeWithMembers();
    const platform = await makeTeam('Platform');
    const teamNotFound = { status: 404, body: { error: 'team_not_found' } };
    expect(
      await ask(postFactory, '/api/factories', member, {
        body: { name: 'Mine', teamId: platform.id },
      }),
    ).toEqual(teamNotFound);
    expect(
      await ask(postFactory, '/api/factories', owner, {
        body: { name: 'Mine', teamId: 'no-such-team' },
      }),
    ).toEqual(teamNotFound);

    const team = await general();
    await makeFactory('Deploys', team.id, member);
    expect(
      await ask(postFactory, '/api/factories', admin, {
        body: { name: 'DEPLOYS', teamId: team.id },
      }),
    ).toEqual({ status: 409, body: { error: 'name_taken' } });
    expect(
      await ask(postFactory, '/api/factories', admin, { body: { name: ' ', teamId: team.id } }),
    ).toEqual({ status: 400, body: { error: 'invalid_factory', problems: ['name_missing'] } });
    for (const body of [{ name: 'Mine' }, { name: 7, teamId: team.id }, 'not json']) {
      expect(await ask(postFactory, '/api/factories', owner, { body })).toEqual({
        status: 400,
        body: { error: 'invalid_request' },
      });
    }
  });

  it('are renamed and moved by whoever sees them, to a team they see', async () => {
    await acmeWithMembers();
    const team = await general();
    const platform = await makeTeam('Platform');
    const deploys = await makeFactory('Deploys', team.id);
    const path = `/api/factories/${deploys.id}`;

    // The member, in General alone, renames it.
    expect(await ask(patchFactory, path, member, { body: { name: ' Ship it ' } })).toEqual({
      status: 200,
      body: { ...deploys, name: 'Ship it' },
    });
    // An admin, in General alone too, moves it to Platform and renames it, in one change.
    expect(
      await ask(patchFactory, path, admin, {
        body: { name: 'Platform deploys', teamId: platform.id },
      }),
    ).toEqual({
      status: 200,
      body: { ...deploys, name: 'Platform deploys', teamId: platform.id },
    });
    expect((await ask(getFactory, path, owner)).body).toMatchObject({
      factory: { name: 'Platform deploys', teamId: platform.id, latestVersion: 1 },
      version: { version: 1, files: [] },
    });
    // Platform owns it now, and General owns nothing.
    expect(await ask(deleteTeam, `/api/teams/${platform.id}`, owner)).toEqual({
      status: 409,
      body: { error: 'owns_factories' },
    });
  });

  it('are renamed or moved by a member only while theirs, and only to a team they are in', async () => {
    await acmeWithMembers();
    const team = await general();
    const platform = await makeTeam('Platform');
    const deploys = await makeFactory('Deploys', platform.id);
    const reviews = await makeFactory('Reviews', team.id);
    const factoryNotFound = { status: 404, body: { error: 'factory_not_found' } };
    const teamNotFound = { status: 404, body: { error: 'team_not_found' } };

    // Platform's factory is not the member's: not found, renamed or moved.
    for (const body of [{ name: 'Mine' }, { teamId: team.id }]) {
      expect(await ask(patchFactory, `/api/factories/${deploys.id}`, member, { body })).toEqual(
        factoryNotFound,
      );
    }
    // General's is, but Platform is no team of theirs to move it to.
    const path = `/api/factories/${reviews.id}`;
    expect(await ask(patchFactory, path, member, { body: { teamId: platform.id } })).toEqual(
      teamNotFound,
    );
    expect(
      await ask(patchFactory, path, member, { body: { name: 'Mine', teamId: platform.id } }),
    ).toEqual(teamNotFound);
    expect(await ask(patchFactory, path, owner, { body: { teamId: 'no-such-team' } })).toEqual(
      teamNotFound,
    );
    expect((await ask(getFactory, path, owner)).body).toMatchObject({ factory: reviews });

    // Once in Platform, they may move it there.
    await ask(putTeamMember, `/api/teams/${platform.id}/members/${member.personId}`, owner);
    expect(await ask(patchFactory, path, member, { body: { teamId: platform.id } })).toEqual({
      status: 200,
      body: { ...reviews, teamId: platform.id },
    });
  });

  it('keep their names unique when renamed, and refuse a change that is none', async () => {
    await acmeWithMembers();
    const team = await general();
    const deploys = await makeFactory('Deploys', team.id);
    await makeFactory('Reviews', team.id);
    const path = `/api/factories/${deploys.id}`;

    expect(await ask(patchFactory, path, owner, { body: { name: 'REVIEWS' } })).toEqual({
      status: 409,
      body: { error: 'name_taken' },
    });
    expect((await ask(patchFactory, path, owner, { body: { name: 'deploys' } })).status).toBe(200);
    expect(await ask(patchFactory, path, owner, { body: { name: ' ' } })).toEqual({
      status: 400,
      body: { error: 'invalid_factory', problems: ['name_missing'] },
    });
    for (const body of [{}, { name: 7 }, { teamId: null }, { colour: 'blue' }, [], 'not json']) {
      expect(await ask(patchFactory, path, owner, { body })).toEqual({
        status: 400,
        body: { error: 'invalid_request' },
      });
    }
    expect(
      await ask(patchFactory, path, owner, {
        body: JSON.stringify({ name: 'Ship' }),
        headers: { 'content-type': 'text/plain' },
      }),
    ).toEqual({ status: 415, body: { error: 'unsupported_media_type' } });
  });

  it('refuse a save from a version that is no longer the latest, naming the latest', async () => {
    await acmeWithMembers();
    const deploys = await makeFactory('Deploys', (await general()).id);
    expect((await saveFiles(deploys.id, owner, { baseVersion: 1, files: FILES })).status).toBe(201);
    for (const baseVersion of [1, 3, -1, 2 ** 40]) {
      expect(await saveFiles(deploys.id, admin, { baseVersion, files: [] })).toEqual({
        status: 409,
        body: { error: 'version_moved', latestVersion: 2 },
      });
    }
  });

  it('refuse a body that is not files, or larger than any factory', async () => {
    await acmeWithMembers();
    const deploys = await makeFactory('Deploys', (await general()).id);
    const path = `/api/factories/${deploys.id}/versions`;
    for (const body of [{ files: [] }, { baseVersion: 1, files: [{ path: 'x' }] }, 'not json']) {
      expect(await ask(postFactoryVersion, path, owner, { body })).toEqual({
        status: 400,
        body: { error: 'invalid_request' },
      });
    }
    expect(
      await ask(postFactoryVersion, path, owner, {
        body: JSON.stringify({ baseVersion: 1, files: [] }),
        headers: { 'content-type': 'text/plain' },
      }),
    ).toEqual({ status: 415, body: { error: 'unsupported_media_type' } });

    const huge = 'a'.repeat(17 * 1024 * 1024);
    expect(
      await ask(postFactoryVersion, path, owner, {
        body: { baseVersion: 1, files: [{ path: 'agents/huge.md', content: huge }] },
      }),
    ).toEqual({ status: 413, body: { error: 'too_large' } });
  });

  it('are pending while the cell does not hold the workspace', async () => {
    const pending = { status: 409, body: { error: 'workspace_pending' } };
    expect(await ask(listFactories, '/api/factories', owner)).toEqual(pending);
    expect(await ask(getFactory, '/api/factories/x', owner)).toEqual(pending);
    expect(
      await ask(postFactory, '/api/factories', owner, { body: { name: 'Mine', teamId: 'x' } }),
    ).toEqual(pending);
    expect(await ask(patchFactory, '/api/factories/x', owner, { body: { name: 'Mine' } })).toEqual(
      pending,
    );
  });

  it("of another workspace are none of the caller's: not found, never saved", async () => {
    await acmeWithMembers();
    const deploys = await makeFactory('Deploys', (await general()).id);
    for (const message of [
      created({ workspaceId: 'sprocket' }),
      outboxMessage(2, { type: 'member.added', ...owner }, { workspaceId: 'sprocket' }),
    ]) {
      expect((await deliver(message)).status).toBe(200);
    }
    const stranger = { ...owner, workspaceId: 'sprocket' };
    const notFound = { status: 404, body: { error: 'factory_not_found' } };
    expect(await factoriesSeenBy(stranger)).toEqual([]);
    expect(await ask(getFactory, `/api/factories/${deploys.id}`, stranger)).toEqual(notFound);
    expect(await saveFiles(deploys.id, stranger, { baseVersion: 1, files: [] })).toEqual(notFound);
    expect(
      await ask(patchFactory, `/api/factories/${deploys.id}`, stranger, { body: { name: 'Mine' } }),
    ).toEqual(notFound);
    expect((await ask(getFactory, `/api/factories/${deploys.id}`, owner)).body).toMatchObject({
      factory: deploys,
    });
  });

  it('keep the team that owns them: it is not deleted', async () => {
    await acmeWithMembers();
    const platform = await makeTeam('Platform');
    await makeFactory('Deploys', platform.id);
    expect(await ask(deleteTeam, `/api/teams/${platform.id}`, owner)).toEqual({
      status: 409,
      body: { error: 'owns_factories' },
    });
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
