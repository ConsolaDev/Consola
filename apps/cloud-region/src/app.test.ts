import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_KEYS_PATH,
  CELL_TOKEN_LIFETIME_SECONDS,
  cellTokenClaims,
  GITHUB_EVENT_ANSWER,
  GITHUB_EVENT_DELIVERY_MEDIA_TYPE,
  GITHUB_EVENT_DELIVERY_PATH,
  GITHUB_EVENT_TYPE,
  OUTBOX_ANSWER,
  OUTBOX_DELIVERY_MEDIA_TYPE,
  OUTBOX_DELIVERY_PATH,
  OUTBOX_MESSAGE_TYPE,
  readOutOfOrderAnswer,
  WORKSPACE_ROLES,
} from '@consola/cloud-contract';
import type {
  CellTokenGrant,
  GitHubEventMessage,
  OutboxMessage,
  WorkspaceChange,
} from '@consola/cloud-contract';
import { CODE_REVIEW_TEAM_FILES } from '@consola/factory-spec';
import {
  PASS_AUDIENCE,
  PASS_MAX_LIFETIME_SECONDS,
  PASS_TYPE,
  readCellMessage,
  readPassClaims,
} from '@consola/runner-protocol';
import type { CellMessage } from '@consola/runner-protocol';
import { asc, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  CompactSign,
  calculateJwkThumbprint,
  compactVerify,
  createLocalJWKSet,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  importJWK,
  SignJWT,
} from 'jose';
import type { CompactJWSHeaderParameters, JSONWebKeySet, JWK, JWTHeaderParameters } from 'jose';
import WebSocket from 'ws';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { ZodType } from 'zod';
import type { CellEnv } from './adapters/http/caller.js';
import {
  deleteTeam,
  deleteTeamMember,
  getCloudSession,
  getCloudSessionOptions,
  getFactory,
  getFactoryVersion,
  getRun,
  postRunApproval,
  listCloudSessions,
  listFactories,
  listFactoryTemplates,
  listRuns,
  listTeams,
  patchFactory,
  patchTeam,
  postCloudSession,
  postCloudSessionPass,
  postCloudSessionStop,
  postFactory,
  postFactoryVersion,
  postGitHubEventDelivery,
  postTeam,
  putTeamMember,
} from './adapters/http/contract.js';
import type { ROUTES } from './adapters/http/contract.js';
import { migrateDatabase, openDatabase } from './adapters/persistence/database.js';
import type { Database } from './adapters/persistence/database.js';
import { createDrizzleStores } from './adapters/persistence/stores.js';
import {
  cloudSessions,
  gitHubEvents,
  workspaceMembers,
  workspaces,
} from './adapters/persistence/tables.js';
import { composeCell } from './compose.js';
import { recordRun } from './application/runs.js';
import { loadConfig } from './config.js';
import type { CellConfig } from './config.js';
import { NO_STEP_DETAIL } from './domain/run.js';
import type { RunWrite, StepRecord } from './domain/run.js';
import { FIRST_TEAM_NAME } from './domain/team.js';

/** `vi.waitFor` with a timeout in line with the suite's own, so a loaded machine does not flake. */
const waitFor = <T>(callback: () => T | Promise<T>) =>
  vi.waitFor(callback, { timeout: 10_000, interval: 25 });

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

type CellApp = Awaited<ReturnType<typeof composeCell>>['app'];
let app: CellApp;
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
 * check, the outbox's deliveries and the GitHub events cloud-global passes on, which carry a
 * signature instead (a bare one has none, and no body, so it is unreadable), and the runner's
 * socket, which carries the runner's secret instead. Nothing else is open.
 */
const OPEN_ROUTES: Record<string, number> = {
  'GET /api/health': 200,
  [`POST ${OUTBOX_DELIVERY_PATH}`]: OUTBOX_ANSWER.unreadable,
  [`POST ${GITHUB_EVENT_DELIVERY_PATH}`]: GITHUB_EVENT_ANSWER.unreadable,
  // The runner's socket, behind its shared secret instead, which a bare request does not carry.
  'GET /api/runner': 401,
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
      const response = await app.request(path.replaceAll(/:[^/]+/g, 'x'), {
        method: method === 'ALL' ? 'GET' : method,
      });
      const route = `${method} ${path}`;
      expect([route, response.status]).toEqual([route, OPEN_ROUTES[route] ?? 401]);
    }
    // Each open route is one the app has.
    const held = new Set(routes.map(({ method, path }) => `${method} ${path}`));
    expect(Object.keys(OPEN_ROUTES).filter((route) => !held.has(route))).toEqual([]);
  });

  it('opens the delivery paths to deliveries alone: any other method needs a token', async () => {
    for (const path of [OUTBOX_DELIVERY_PATH, GITHUB_EVENT_DELIVERY_PATH]) {
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        const response = await app.request(path, { method });
        expect([path, method, response.status]).toEqual([path, method, 401]);
        expect(await response.json()).toEqual({ error: 'token_required' });
      }
    }
  });

  it('that does not exist is 401 without a token, and 404 only with one', async () => {
    for (const path of ['/', '/api/nowhere', '/api/workspaces/sprocket']) {
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
      // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- the Database type's raw results are `unknown`; a type argument cannot name the rows
      const result = (await db.execute(
        sql`select body from note where workspace_id = ${c.var.caller.workspaceId}`,
      )) as unknown as { rows: Array<{ body: string }> };
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
      issues: Array<{ file?: string; line?: number; message: string }>;
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

// GitHub's events are signed here the way cloud-global signs them: the event's JSON as the
// payload of a compact JWS, with the cell token's key, its kid and the event's typ.

/** Acme (EU) hears of a pull request opened in the `sprocket` organisation's repository. */
const pullRequestOpened = (overrides: Partial<GitHubEventMessage> = {}): GitHubEventMessage => ({
  workspaceId: 'acme',
  region: 'eu',
  deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
  event: 'pull_request',
  installationId: 41,
  payload: {
    action: 'opened',
    number: 7,
    pull_request: { title: 'Price the catalog in euros', body: 'Customers in Lyon asked.' },
    repository: { full_name: 'sprocket/catalog-portal', private: true },
    installation: { id: 41 },
  },
  ...overrides,
});

const signEvent = (
  event: unknown,
  key: SigningKey = cloudGlobal,
  header: Partial<CompactJWSHeaderParameters> = {},
) => signDelivery(event, key, { typ: GITHUB_EVENT_TYPE, ...header });

/** POSTs `body` to the GitHub events route of `cell` (this test's cell unless given). */
function postEvent(
  body: string,
  options: { contentType?: string | null; cell?: CellApp; headers?: Record<string, string> } = {},
) {
  const { contentType = GITHUB_EVENT_DELIVERY_MEDIA_TYPE, cell = app } = options;
  const headers: Record<string, string> = { ...options.headers };
  if (contentType !== null) headers['content-type'] = contentType;
  return cell.request(GITHUB_EVENT_DELIVERY_PATH, { method: 'POST', body, headers });
}

/** Signs `event` as cloud-global does and passes it on, reading the answer by the contract. */
async function passOn(event: unknown, options: Parameters<typeof postEvent>[1] = {}) {
  const response = await postEvent(await signEvent(event), options);
  return { status: response.status, body: await answerOf(postGitHubEventDelivery, response) };
}

const recordedEvents = () =>
  db
    .select()
    .from(gitHubEvents)
    .orderBy(asc(gitHubEvents.workspaceId), asc(gitHubEvents.deliveryId));

describe('POST /api/github/events', () => {
  let logged: MockInstance<typeof console.error>;
  beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it("records a pull request opened in the workspace's repository, as GitHub sent it", async () => {
    expect((await deliver(created())).status).toBe(200);
    const event = pullRequestOpened();
    expect(await passOn(event)).toEqual({ status: 201, body: { recorded: true } });

    const rows = await recordedEvents();
    expect(rows.map(({ receivedAt: _at, ...row }) => row)).toEqual([
      {
        workspaceId: 'acme',
        deliveryId: event.deliveryId,
        event: 'pull_request',
        installationId: 41,
        payload: JSON.stringify(event.payload),
      },
    ]);
    // Ids and names reach the log, never what the event says.
    expect(logged.mock.calls.flat().join('\n')).not.toContain('Lyon');
  });

  it('records a delivery once, however often it arrives, at once or later', async () => {
    expect((await deliver(created())).status).toBe(200);
    const delivery = await signEvent(pullRequestOpened());
    const statuses = await Promise.all(
      Array.from({ length: 4 }, async () => (await postEvent(delivery)).status),
    );
    expect(statuses.sort((a, b) => a - b)).toEqual([200, 200, 200, 201]);
    // A replay with another payload under the same delivery id changes nothing either.
    const replay = pullRequestOpened({ payload: { action: 'closed', installation: { id: 41 } } });
    expect(await passOn(replay)).toEqual({ status: 200, body: { recorded: true } });
    const rows = await recordedEvents();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toMatchObject({ action: 'opened' });
  });

  it('needs no cell token, and reads none it is sent', async () => {
    expect((await deliver(created())).status).toBe(200);
    expect(await passOn(pullRequestOpened(), { headers: bearer('forged') })).toEqual({
      status: 201,
      body: { recorded: true },
    });
  });

  it('refuses an event for a workspace it does not hold yet with 409, recording nothing', async () => {
    expect(await passOn(pullRequestOpened())).toEqual({
      status: GITHUB_EVENT_ANSWER.workspacePending,
      body: { error: 'workspacePending' },
    });
    expect(await recordedEvents()).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      'The cell refused GitHub delivery 72d3162e-cc78-11e3-81ab-4c9367dc0958 (pull_request) for workspace acme: it does not hold the workspace yet.',
    );
  });

  it("refuses an event for another region's workspace with 421", async () => {
    const event = pullRequestOpened({ workspaceId: 'sprocket', region: 'us' });
    expect(await passOn(event)).toEqual({
      status: GITHUB_EVENT_ANSWER.otherRegion,
      body: { error: 'otherRegion', region: 'eu' },
    });
    expect(await recordedEvents()).toEqual([]);
  });

  it("is the other cell's to record", async () => {
    const us = await openCell({ ...config, region: 'us' });
    const sprocket = { workspaceId: 'sprocket', region: 'us' } as const;
    const opened = await postDelivery(await signDelivery(created(sprocket)), { cell: us.app });
    expect(opened.status).toBe(200);
    expect(await passOn(pullRequestOpened(sprocket), { cell: us.app })).toEqual({
      status: 201,
      body: { recorded: true },
    });
    await us.close();
  });

  it.each<[string, () => Promise<string>]>([
    ['an outbox message', () => signDelivery(pullRequestOpened())],
    ['a cell token', () => mint()],
    [
      'one signed by a key cloud-global does not publish',
      () => signEvent(pullRequestOpened(), stranger),
    ],
    [
      'one whose payload was changed after signing',
      async () => {
        const [header, , signature] = (await signEvent(pullRequestOpened())).split('.');
        const changed = pullRequestOpened({ workspaceId: 'sprocket' });
        return [header, base64url(changed), signature].join('.');
      },
    ],
    ['the event, unsigned', async () => JSON.stringify(pullRequestOpened())],
  ])('refuses %s with 401, recording nothing', async (_what, delivery) => {
    expect((await deliver(created())).status).toBe(200);
    const response = await postEvent(await delivery());
    expect(response.status).toBe(GITHUB_EVENT_ANSWER.unsigned);
    expect(await answerOf(postGitHubEventDelivery, response)).toEqual({ error: 'unsigned' });
    expect(await recordedEvents()).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(/^The cell refused a GitHub event: it is not signed by cloud-global/),
    );
  });

  it('refuses an event sent to the outbox, which takes messages alone', async () => {
    const response = await postDelivery(await signEvent(pullRequestOpened()));
    expect(response.status).toBe(OUTBOX_ANSWER.unsigned);
  });

  it('refuses a body not sent as application/jose with 400, before reading it', async () => {
    const delivery = await signEvent(pullRequestOpened());
    for (const contentType of ['application/json', null]) {
      const response = await postEvent(delivery, { contentType });
      expect(response.status).toBe(GITHUB_EVENT_ANSWER.unreadable);
      expect(await answerOf(postGitHubEventDelivery, response)).toEqual({ error: 'unreadable' });
    }
    expect(logged).toHaveBeenCalledWith(
      'The cell refused a GitHub event: it was not sent as application/jose.',
    );
  });

  it('refuses a signed event the contract does not read with 400, logging why but not the body', async () => {
    const elsewhere = pullRequestOpened({
      payload: { action: 'opened', body: 'Customers in Lyon asked.', installation: { id: 42 } },
    });
    const response = await postEvent(await signEvent(elsewhere));
    expect(response.status).toBe(GITHUB_EVENT_ANSWER.unreadable);
    expect(await answerOf(postGitHubEventDelivery, response)).toEqual({ error: 'unreadable' });
    expect(logged).toHaveBeenLastCalledWith(
      'The cell refused a GitHub event: its message does not read (`payload.installation.id` is not `installationId`).',
    );
    expect(logged.mock.calls.flat().join('\n')).not.toContain('Lyon');
  });

  it('answers 503 when the database does not, recording nothing', async () => {
    expect((await deliver(created())).status).toBe(200);
    const delivery = await signEvent(pullRequestOpened());
    await closeDatabase();
    const response = await postEvent(delivery);
    expect(response.status).toBe(GITHUB_EVENT_ANSWER.unavailable);
    expect(await answerOf(postGitHubEventDelivery, response)).toEqual({ error: 'unavailable' });
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(
        /^The cell could not record GitHub delivery 72d3162e-cc78-11e3-81ab-4c9367dc0958 \(pull_request\) for workspace acme: /,
      ),
    );
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
    // Signed with cloud-global's key and a delivery's typ: the typ alone refuses it.
    for (const delivery of [await signDelivery(claims()), await signEvent(claims())]) {
      const response = await app.request('/api/me', { headers: bearer(delivery) });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'invalid_token' });
    }
  });
});

describe('agent teams', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  /** A pull request opened in Acme's repository, as GitHub POSTs it. */
  const opened = (deliveryId: string): GitHubEventMessage =>
    pullRequestOpened({
      deliveryId,
      payload: {
        action: 'opened',
        number: 7,
        pull_request: {
          number: 7,
          html_url: 'https://github.com/sprocket/catalog-portal/pull/7',
          title: 'Price the catalog in euros',
          body: 'Customers in Lyon asked.',
          draft: false,
          user: { login: 'octocat', type: 'User' },
          head: { sha: 'b'.repeat(40), ref: 'euros' },
          base: { ref: 'main' },
          labels: [],
        },
        repository: { full_name: 'sprocket/catalog-portal' },
        installation: { id: 41 },
      },
    });

  it('offer the code review team as a template, its files as factory-spec writes them', async () => {
    const answer = await ask(listFactoryTemplates, '/api/factory-templates', member);
    expect(answer).toEqual({
      status: 200,
      body: [
        {
          id: 'code-review-team',
          name: 'Code review team',
          description: expect.any(String),
          files: CODE_REVIEW_TEAM_FILES.map(({ path, content }) => ({ path, content })),
        },
      ],
    });
  });

  it("save beside the steps design's files with no issue, and refuse a team's problems by file", async () => {
    await acmeWithMembers();
    const [first] = (await teamsSeenBy(owner)).teams;
    const factory = await makeFactory('Reviews', first?.id ?? '');
    const both = [
      ...FILES,
      ...CODE_REVIEW_TEAM_FILES.map(({ path, content }) => ({ path, content })),
    ];
    const saved = await saveFiles(factory.id, member, { baseVersion: 1, files: both });
    expect(saved).toMatchObject({ status: 201, body: { notices: [] } });

    const broken = [
      ...both,
      { path: 'agents/stray/agent.md', content: '---\nagentType: NOBODY\n---\nHi.\n' },
    ];
    const refused = await saveFiles(factory.id, member, { baseVersion: 2, files: broken });
    expect(refused).toMatchObject({
      status: 400,
      body: {
        error: 'invalid_files',
        issues: expect.arrayContaining([
          expect.objectContaining({ file: 'agents/stray/agent.md' }),
        ]),
      },
    });
  });

  it('start an agent run on an opened pull request, which every member sees failed when no runner is connected', async () => {
    await acmeWithMembers();
    const [first] = (await teamsSeenBy(owner)).teams;
    const factory = await makeFactory('Reviews', first?.id ?? '');
    await saveFiles(factory.id, owner, {
      baseVersion: 1,
      files: CODE_REVIEW_TEAM_FILES.map(({ path, content }) => ({ path, content })),
    });

    expect(await passOn(opened('5e1f0a2c-0001'))).toEqual({
      status: 201,
      body: { recorded: true },
    });
    // Delivered again: recorded before, so it starts nothing more.
    expect(await passOn(opened('5e1f0a2c-0001'))).toEqual({
      status: 200,
      body: { recorded: true },
    });

    const listed = await ask(listCloudSessions, '/api/cloud-sessions', member);
    expect(listed).toEqual({
      status: 200,
      body: [
        expect.objectContaining({
          personId: null,
          runnerId: null,
          status: 'failed',
          errorCode: 'runner_unavailable',
          title: 'review-pull-requests · sprocket/catalog-portal#7 Price the catalog in euros',
          origin: expect.objectContaining({ factoryId: factory.id, agent: 'foreman' }),
          agentRun: null,
        }),
      ],
    });
  });
});

describe('cloud sessions, with no runner connected (the channel when no runner socket is set up)', () => {
  const start = { repository: 'sprocket/catalog-portal', harness: 'claude' };

  it('answers 503 {"error":"no_runner"} to a start and records nothing', async () => {
    const response = await app.request('/api/cloud-sessions', {
      method: 'POST',
      headers: { ...bearer(await mint()), 'content-type': 'application/json' },
      body: JSON.stringify(start),
    });
    expect(response.status).toBe(503);
    expect(await answerOf(postCloudSession, response.clone())).toEqual({ error: 'no_runner' });
    expect(await response.text()).toBe('{"error":"no_runner"}');
    expect(await db.select().from(cloudSessions)).toEqual([]);
  });

  it('answers 503 no_runner to the options', async () => {
    expect(await ask(getCloudSessionOptions, '/api/cloud-sessions/options', {})).toEqual({
      status: 503,
      body: { error: 'no_runner' },
    });
  });

  it('lists none, and holds no session by any id', async () => {
    expect(await ask(listCloudSessions, '/api/cloud-sessions', {})).toEqual({
      status: 200,
      body: [],
    });
    expect(await ask(getCloudSession, '/api/cloud-sessions/session-1', {})).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
    expect(await ask(postCloudSessionStop, '/api/cloud-sessions/session-1/stop', {})).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
  });

  it('checks the token before the body', async () => {
    expect(await ask(postCloudSession, '/api/cloud-sessions', {}, { body: '{nope' })).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
    const response = await app.request('/api/cloud-sessions', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{nope',
    });
    expect(response.status).toBe(401);
    expect(await answerOf(postCloudSession, response)).toEqual({ error: 'token_required' });
  });

  it('needs a token', async () => {
    const listed = await app.request('/api/cloud-sessions');
    expect(listed.status).toBe(401);
    expect(await answerOf(listCloudSessions, listed)).toEqual({ error: 'token_required' });
    const started = await app.request('/api/cloud-sessions', { method: 'POST' });
    expect(started.status).toBe(401);
    expect(await answerOf(postCloudSession, started)).toEqual({ error: 'token_required' });
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
    const body = (await answerOf(postCloudSessionPass, response)) as {
      pass: string;
      hostUrl: string;
      expiresAt: number;
    };
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
      expect(await answerOf(postCloudSessionPass, response)).toEqual({ error: 'not_found' });
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
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await answerOf(postCloudSessionPass, response)).toEqual({ error: 'no_runner' });
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
    await waitFor(async () => {
      const options = await cell.app.request('/api/cloud-sessions/options', {
        headers: bearer(token),
      });
      expect(options.status).toBe(200);
      expect(await answerOf(getCloudSessionOptions, options)).toEqual({
        repositories: ['sprocket/catalog-portal'],
        harnesses: ['claude'],
      });
    });

    const started = await cell.app.request('/api/cloud-sessions', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ repository: 'sprocket/catalog-portal', harness: 'claude' }),
    });
    expect(started.status).toBe(201);
    const session = (await answerOf(postCloudSession, started)) as { id: string; status: string };
    expect(session.status).toBe('starting');
    await waitFor(() => expect(received).toHaveLength(1));
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
    await waitFor(async () => {
      const pass = await cell.app.request(`/api/cloud-sessions/${session.id}/pass`, {
        method: 'POST',
        headers: bearer(token),
      });
      expect(pass.status).toBe(200);
      expect(await answerOf(postCloudSessionPass, pass)).toMatchObject({
        hostUrl: 'https://3000-sandbox.e2b.example',
      });
    });
    const reread = await cell.app.request(`/api/cloud-sessions/${session.id}`, {
      headers: bearer(token),
    });
    expect(await answerOf(getCloudSession, reread)).toMatchObject({
      id: session.id,
      status: 'running',
      hostUrl: 'https://3000-sandbox.e2b.example',
      runnerId: 'runner-1',
    });

    expect(logs()).not.toContain(RUNNER_SECRET);
    expect(logs()).not.toContain(String(passJwk.d));
    socket.terminate();
    await cell.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

// Runs: recorded through the store, as a runner will, and read over HTTP.

const runStep = (id: string, kind: StepRecord['kind'] = 'agent'): StepRecord => ({
  id,
  kind,
  status: 'running',
  attempt: 1,
  agent: kind === 'agent' ? 'reviewer' : null,
  model: null,
  startedAt: null,
  finishedAt: null,
  costUsd: null,
  error: null,
  skipped: null,
  ...NO_STEP_DETAIL,
});

const minute = (n: number) => new Date(Date.UTC(2026, 10, 20, 10, n)).toISOString();

const cronRun = (id: string, factoryId: string, overrides: Partial<RunWrite> = {}): RunWrite => ({
  id,
  factoryId,
  factoryVersion: 1,
  parent: null,
  automation: 'nightly',
  status: 'completed',
  waitingOn: null,
  trigger: 'cron',
  triggerDetail: '0 3 * * *',
  startedBy: null,
  item: null,
  runner: 'cloud',
  steps: [runStep('build')],
  request: null,
  summary: 'Built.',
  error: null,
  costUsd: 0.1,
  createdAt: minute(0),
  startedAt: minute(0),
  finishedAt: minute(1),
  updatedAt: minute(1),
  ...overrides,
});

const personsRequest = (id: string, factoryId: string, overrides: Partial<RunWrite> = {}) =>
  cronRun(id, factoryId, {
    automation: null,
    status: 'waiting',
    waitingOn: 'run',
    trigger: 'manual',
    triggerDetail: null,
    startedBy: member.personId,
    steps: [runStep('orchestrator', 'orchestrator')],
    request: {
      text: '<b>Ship</b> the billing page\nby Friday.',
      budget: { usd: 20, runs: 8 },
      spent: { usd: 2.5, runs: 1 },
      question: null,
    },
    summary: null,
    costUsd: 2.5,
    finishedAt: null,
    ...overrides,
  });

async function recordRuns(...runs: RunWrite[]) {
  const store = createDrizzleStores(db).runs;
  for (const run of runs) {
    expect([run.id, (await recordRun(store, 'acme', run)).kind]).toEqual([run.id, 'recorded']);
  }
}

type RunListBody = {
  runs: Array<{ id: string; phase: string; children: unknown; title: string }>;
  nextCursor: string | null;
  counts: Record<string, number>;
  facets: {
    factories: Array<{ id: string }>;
    teams: Array<{ id: string }>;
    automations: unknown[];
  };
};

async function runsSeenBy(who: Partial<CellTokenGrant>, search = '') {
  const answer = await ask(listRuns, `/api/runs${search}`, who);
  expect(answer.status).toBe(200);
  return answer.body as RunListBody;
}

describe('runs', () => {
  /** Acme with a Platform team only the owner is in: General owns Reviews, Platform Deploys. */
  async function acmeWithFactories() {
    await acmeWithMembers();
    const platform = await makeTeam('Platform');
    const [general] = (await teamsSeenBy(owner)).teams;
    if (!general) throw new Error('Acme has no first team');
    const reviews = await makeFactory('Reviews', general.id);
    const deploys = await makeFactory('Deploys', platform.id);
    return { general, platform, reviews, deploys };
  }

  it('list the runs of the factories the caller sees, newest first, with counts and facets', async () => {
    const { general, platform, reviews, deploys } = await acmeWithFactories();
    await recordRuns(
      cronRun('reviews-nightly', reviews.id),
      personsRequest('ship', reviews.id, { createdAt: minute(5) }),
      cronRun('ship-review', reviews.id, {
        parent: { runId: 'ship', move: 1 },
        trigger: 'manual',
        triggerDetail: null,
        automation: 'review',
        status: 'needs-approval',
        createdAt: minute(6),
      }),
      cronRun('deploys-nightly', deploys.id, { createdAt: minute(2), status: 'failed' }),
    );

    const forOwner = await runsSeenBy(owner);
    expect(forOwner.runs.map((run) => [run.id, run.phase])).toEqual([
      ['ship', 'needs-you'],
      ['deploys-nightly', 'failed'],
      ['reviews-nightly', 'completed'],
    ]);
    expect(forOwner.runs[0]?.title).toBe('<b>Ship</b> the billing page');
    expect(forOwner.runs[0]?.children).toEqual({ total: 1, active: 0, needsYou: 1, failed: 0 });
    expect(forOwner.counts).toEqual({
      active: 0,
      'needs-you': 1,
      completed: 1,
      failed: 1,
      stopped: 0,
    });
    expect(forOwner.nextCursor).toBeNull();
    expect(forOwner.facets).toEqual({
      factories: [
        { id: deploys.id, name: 'Deploys', teamId: platform.id, latestVersion: 1 },
        { id: reviews.id, name: 'Reviews', teamId: general.id, latestVersion: 1 },
      ],
      teams: [
        { id: general.id, name: FIRST_TEAM_NAME },
        { id: platform.id, name: 'Platform' },
      ],
      // By name, then by factory id.
      automations: [
        ...[deploys.id, reviews.id].sort().map((factoryId) => ({ factoryId, name: 'nightly' })),
        { factoryId: reviews.id, name: 'review' },
      ],
    });

    const forMember = await runsSeenBy(member);
    expect(forMember.runs.map((run) => run.id)).toEqual(['ship', 'reviews-nightly']);
    expect(forMember.facets.factories.map((factory) => factory.id)).toEqual([reviews.id]);
    expect(forMember.facets.teams.map((team) => team.id)).toEqual([general.id]);
  });

  it('read a request with its facts and runs, and a run with the request that started it', async () => {
    const { reviews } = await acmeWithFactories();
    await recordRuns(
      personsRequest('ship', reviews.id),
      cronRun('ship-review', reviews.id, {
        parent: { runId: 'ship', move: 1 },
        trigger: 'manual',
        triggerDetail: null,
        automation: 'review',
        status: 'running',
        finishedAt: null,
      }),
    );
    const ship = await ask(getRun, '/api/runs/ship', member);
    expect(ship.status).toBe(200);
    expect(ship.body).toMatchObject({
      run: {
        id: 'ship',
        kind: 'request',
        progress: null,
        costUsd: 2.5,
        startedBy: member.personId,
      },
      parent: null,
      steps: [{ id: 'orchestrator', kind: 'orchestrator' }],
      request: {
        text: '<b>Ship</b> the billing page\nby Friday.',
        budget: { usd: 20, runs: 8 },
        spent: { usd: 2.5, runs: 1 },
        question: null,
      },
      children: [{ id: 'ship-review', parentId: 'ship', trigger: 'manual', startedBy: null }],
      conversation: null,
    });

    const child = await ask(getRun, '/api/runs/ship-review', member);
    expect(child.body).toMatchObject({
      run: { kind: 'automation', progress: { total: 1, done: 0, current: 'build' } },
      parent: { id: 'ship', title: '<b>Ship</b> the billing page' },
      request: null,
      children: [],
    });
  });

  it('show what each step was asked, did, printed and produced', async () => {
    const { reviews } = await acmeWithFactories();
    const saved = await saveFiles(reviews.id, owner, {
      baseVersion: 1,
      files: [
        { path: 'factory.yml', content: 'version: 1\n' },
        {
          path: 'automations/nightly.yaml',
          content:
            'on: { cron: "0 3 * * *" }\nscope: storefront\nsteps:\n  - id: build\n    run: pnpm build\n    env: { TARGET: storefront }\n',
        },
      ],
    });
    expect(saved.status).toBe(201);
    const build: StepRecord = {
      ...runStep('build', 'run'),
      status: 'completed',
      artifacts: [{ name: 'output', bytes: 912 }],
      command: { exitCode: 0, signal: null, stdoutBytes: 900, stderrBytes: 12, truncated: false },
      output: { stdout: '<b>✓ built</b>\n', stderr: 'warn\n', truncated: false },
    };
    await recordRuns(cronRun('nightly-v2', reviews.id, { factoryVersion: 2, steps: [build] }));

    const answer = await ask(getRun, '/api/runs/nightly-v2', member);
    expect(answer.status).toBe(200);
    expect((answer.body as { steps: unknown[] }).steps).toEqual([
      {
        ...build,
        definition: {
          kind: 'run',
          prompt: null,
          action: null,
          agent: null,
          run: 'pnpm build',
          env: [{ name: 'TARGET', value: 'storefront' }],
          if: null,
          outputs: [],
          artifacts: [],
          maxTurns: null,
          timeoutMs: 600_000,
          file: 'automations/nightly.yaml',
          version: 2,
          range: { start: 4, end: 6 },
        },
      },
    ]);
  });

  it('are not found for a member outside the team, an unknown id, or another workspace', async () => {
    const { deploys } = await acmeWithFactories();
    await recordRuns(cronRun('deploys-nightly', deploys.id));
    const notFound = { status: 404, body: { error: 'run_not_found' } };
    expect(await ask(getRun, '/api/runs/deploys-nightly', member)).toEqual(notFound);
    expect(await ask(getRun, '/api/runs/nothing', owner)).toEqual(notFound);
    expect((await ask(getRun, '/api/runs/deploys-nightly', admin)).status).toBe(200);
    expect((await runsSeenBy(member, `?factoryId=${deploys.id}`)).runs).toEqual([]);

    for (const message of [
      created({ workspaceId: 'sprocket' }),
      outboxMessage(2, { type: 'member.added', ...owner }, { workspaceId: 'sprocket' }),
    ]) {
      expect((await deliver(message)).status).toBe(200);
    }
    const stranger = { ...owner, workspaceId: 'sprocket' };
    expect(await ask(getRun, '/api/runs/deploys-nightly', stranger)).toEqual(notFound);
    expect((await runsSeenBy(stranger)).runs).toEqual([]);
  });

  it('take a filter given once or repeated, page by the cursor, and ignore what they do not know', async () => {
    const { reviews } = await acmeWithFactories();
    await recordRuns(
      cronRun('a', reviews.id, { createdAt: minute(1), status: 'failed' }),
      cronRun('b', reviews.id, {
        createdAt: minute(2),
        trigger: 'poll',
        triggerDetail: 'gh pr list',
      }),
      cronRun('c', reviews.id, {
        createdAt: minute(3),
        trigger: 'manual',
        triggerDetail: null,
        startedBy: member.personId,
      }),
    );
    const ids = async (search: string) =>
      (await runsSeenBy(member, search)).runs.map((run) => run.id);
    expect(await ids('?phase=failed')).toEqual(['a']);
    expect(await ids('?phase=failed&phase=completed')).toEqual(['c', 'b', 'a']);
    expect(await ids('?trigger=cron&trigger=poll')).toEqual(['b', 'a']);
    expect(await ids('?mine=true')).toEqual(['c']);
    expect(await ids('?mine=false&colour=blue')).toEqual(['c', 'b', 'a']);
    expect(await ids('?q=NIGHT')).toEqual(['c', 'b', 'a']);

    const first = await runsSeenBy(member, '?limit=2');
    expect(first.runs.map((run) => run.id)).toEqual(['c', 'b']);
    expect(first.counts).toMatchObject({ completed: 2, failed: 1 });
    const second = await runsSeenBy(member, `?limit=2&cursor=${first.nextCursor}`);
    expect(second.runs.map((run) => run.id)).toEqual(['a']);
    expect(second.nextCursor).toBeNull();
  });

  it('refuse a query they cannot read with 400', async () => {
    await acmeWithFactories();
    const invalid = { status: 400, body: { error: 'invalid_request' } };
    for (const search of [
      '?phase=sleeping',
      '?phase=active&phase=sleeping',
      '?trigger=webhook',
      '?limit=0',
      '?limit=101',
      '?limit=ten',
      '?mine=yes',
      `?q=${'a'.repeat(201)}`,
      '?cursor=not-one-of-ours',
    ]) {
      expect([search, await ask(listRuns, `/api/runs${search}`, member)]).toEqual([
        search,
        invalid,
      ]);
    }
  });

  it('are pending while the cell does not hold the workspace', async () => {
    const pending = { status: 409, body: { error: 'workspace_pending' } };
    expect(await ask(listRuns, '/api/runs', owner)).toEqual(pending);
    expect(await ask(getRun, '/api/runs/any', owner)).toEqual(pending);
    const body = { decision: 'approve', version: 1 };
    expect(await ask(postRunApproval, '/api/runs/any/approval', owner, { body })).toEqual(pending);
  });

  describe('waiting for approval', () => {
    const answerAs = (who: Partial<CellTokenGrant>, runId: string, body: unknown) =>
      ask(postRunApproval, `/api/runs/${runId}/approval`, who, { body });
    const waiting = { status: 'needs-approval', startedAt: null, finishedAt: null } as const;

    /** A run of Reviews (General: everyone) and one of Deploys (Platform: nobody yet), waiting. */
    async function acmeWaiting() {
      const made = await acmeWithFactories();
      const saved = await saveFiles(made.reviews.id, owner, {
        baseVersion: 1,
        files: [
          { path: 'factory.yml', content: 'version: 1\n' },
          {
            path: 'automations/nightly.yaml',
            content:
              'on: { cron: "0 3 * * *" }\nscope: storefront\nmode: confirm\nsteps:\n  - id: build\n    run: pnpm build\n',
          },
        ],
      });
      expect(saved.status).toBe(201);
      await recordRuns(
        cronRun('reviews-wait', made.reviews.id, { ...waiting, factoryVersion: 2 }),
        cronRun('deploys-wait', made.deploys.id, waiting),
        cronRun('reviews-done', made.reviews.id, { factoryVersion: 2 }),
      );
      return made;
    }

    it('show the run its approval and the file behind it', async () => {
      const { general } = await acmeWaiting();
      const read = await ask(getRun, '/api/runs/reviews-wait', member);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        source: {
          path: 'automations/nightly.yaml',
          version: 2,
          latestVersion: 2,
          range: { start: 1, end: 6 },
          trigger: { kind: 'cron', detail: '0 3 * * *' },
          mode: 'confirm',
          appliesTo: [],
        },
        steps: [{ id: 'build', definition: { range: { start: 5, end: 6 } } }],
        approval: {
          version: 2,
          reason: 'nightly asks before every run.',
          team: { id: general.id, name: FIRST_TEAM_NAME },
          mayAnswer: true,
          will: { commands: [{ step: 'build', command: 'pnpm build' }], agents: [] },
          answer: null,
        },
      });
      expect((await ask(getRun, '/api/runs/reviews-done', member)).body).toMatchObject({
        approval: null,
      });
    });

    it('take an answer from anyone on the team, the first one, and leave the run waiting', async () => {
      await acmeWaiting();
      const approved = await answerAs(member, 'reviews-wait', { decision: 'approve', version: 2 });
      expect(approved).toMatchObject({
        status: 201,
        body: { answer: { decision: 'approved', by: member.personId, at: expect.any(String) } },
      });
      expect(await answerAs(admin, 'reviews-wait', { decision: 'dismiss', version: 2 })).toEqual({
        status: 409,
        body: { error: 'already_answered' },
      });
      const read = await ask(getRun, '/api/runs/reviews-wait', owner);
      expect(read.body).toMatchObject({
        run: { status: 'needs-approval' },
        approval: { mayAnswer: true, answer: { decision: 'approved', by: member.personId } },
      });
    });

    it('are not found by a member of another team, and refused to whoever sees the run but is not on its team', async () => {
      const { platform } = await acmeWaiting();
      const body = { decision: 'dismiss', version: 1 };
      expect(await answerAs(member, 'deploys-wait', body)).toEqual({
        status: 404,
        body: { error: 'run_not_found' },
      });
      expect(await answerAs(owner, 'deploys-wait', body)).toEqual({
        status: 403,
        body: { error: 'not_allowed' },
      });
      expect((await ask(getRun, '/api/runs/deploys-wait', owner)).body).toMatchObject({
        approval: { mayAnswer: false },
      });
      // On the team, the owner may: whatever their role, the team decides.
      await ask(putTeamMember, `/api/teams/${platform.id}/members/${owner.personId}`, owner);
      expect(await answerAs(owner, 'deploys-wait', body)).toMatchObject({
        status: 201,
        body: { answer: { decision: 'dismissed', by: owner.personId } },
      });
    });

    it('refuse a run that does not wait, a version that moved, and a body they cannot read', async () => {
      await acmeWaiting();
      expect(await answerAs(member, 'reviews-done', { decision: 'approve', version: 2 })).toEqual({
        status: 409,
        body: { error: 'not_waiting' },
      });
      expect(await answerAs(member, 'reviews-wait', { decision: 'approve', version: 1 })).toEqual({
        status: 409,
        body: { error: 'version_moved' },
      });
      const invalid = { status: 400, body: { error: 'invalid_request' } };
      for (const body of [{ decision: 'maybe', version: 2 }, { decision: 'approve' }, 'not json']) {
        expect(await answerAs(member, 'reviews-wait', body)).toEqual(invalid);
      }
      expect(
        await ask(postRunApproval, '/api/runs/reviews-wait/approval', member, {
          body: 'decision=approve',
          headers: { 'content-type': 'text/plain' },
        }),
      ).toEqual({ status: 415, body: { error: 'unsupported_media_type' } });
    });
  });
});
