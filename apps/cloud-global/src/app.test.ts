import { createHmac, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_AUDIENCE,
  CELL_TOKEN_KEYS_PATH,
  CELL_TOKEN_LIFETIME_SECONDS,
  CLOCK_SKEW_SECONDS,
  GITHUB_EVENT_DELIVERY_MEDIA_TYPE,
  GITHUB_EVENT_DELIVERY_PATH,
  GITHUB_EVENT_TYPE,
  GITHUB_PAYLOAD_MAX_BYTES,
  GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS,
  GITHUB_TOKEN_REQUEST_TYPE,
  gitHubTokenRequest,
  OUTBOX_DELIVERY_MEDIA_TYPE,
  OUTBOX_DELIVERY_PATH,
  OUTBOX_MESSAGE_TYPE,
  readCellTokenClaims,
  readGitHubEventMessage,
  readOutboxMessage,
} from '@consola/cloud-contract';
import type { GitHubEventMessage, GitHubTokenAsk } from '@consola/cloud-contract';
import { organization, testUtils } from 'better-auth/plugins';
import type { TestHelpers } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import {
  CompactSign,
  calculateJwkThumbprint,
  compactVerify,
  createLocalJWKSet,
  jwtVerify,
} from 'jose';
import type { JSONWebKeySet } from 'jose';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closedPaths } from './adapters/auth/betterAuth.js';
import type { CloudAuth } from './adapters/auth/betterAuth.js';
import { ROUTES } from './adapters/http/contract.js';
import type { OutboxWorker } from './adapters/outbox/outboxWorker.js';
import { migrateDatabase, openDatabase } from './adapters/persistence/database.js';
import type { Database } from './adapters/persistence/database.js';
import { schema } from './adapters/persistence/schema.js';
import { composeApi } from './compose.js';
import { ConfigError } from './config.js';
import type { CloudConfig, Ed25519PrivateJwk, Ed25519PublicJwk } from './config.js';

const WEB_ORIGIN = 'http://localhost:5175';
const ACME_CELL = 'http://127.0.0.1:3101';
const SPROCKET_CELL = 'http://127.0.0.1:3102';

// A key made for this run only, never one written down.
const cellKey = generateKeyPairSync('ed25519').privateKey.export({
  format: 'jwk',
}) as Ed25519PrivateJwk;

// Each region's cell's own key, made for this run only: the cells sign their requests with them.
const cellPairOf = () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const x = privateKey.export({ format: 'jwk' }).x as string;
  return { privateKey, publicJwk: { kty: 'OKP', crv: 'Ed25519', x } as Ed25519PublicJwk };
};
const euCell = cellPairOf();
const usCell = cellPairOf();

const config: CloudConfig = {
  databaseUrl: 'pglite:memory',
  authSecret: 'sprocket-test-secret-that-is-long-enough-to-sign-with',
  publicUrl: WEB_ORIGIN,
  port: 3100,
  google: { clientId: 'sprocket-test-client-id', clientSecret: 'sprocket-test-client-secret' },
  cellTokenPrivateKey: cellKey,
  // A cell in each region, which no test reaches unless it starts the outbox's worker.
  cellUrls: { eu: ACME_CELL, us: SPROCKET_CELL },
  cellPublicKeys: { eu: euCell.publicJwk, us: usCell.publicJwk },
  github: null,
  githubWebhookSecret: null,
};

let db: Database;
let closeDatabase: () => Promise<void>;
let auth: CloudAuth;
let test: TestHelpers;
let app: OpenAPIHono;
let outbox: OutboxWorker;
// Better Auth keeps rate-limit counts per client address and path for the whole file, so each
// test signs in from an address of its own (TEST-NET-3, never routed).
let clients = 0;
let clientIp: string;

beforeEach(async () => {
  clients += 1;
  clientIp = `203.0.113.${clients}`;
  const opened = openDatabase(config.databaseUrl);
  db = opened.db;
  let closed = false;
  closeDatabase = async () => {
    if (closed) return;
    closed = true;
    await opened.close();
  };
  await migrateDatabase(db);
  // Built the way main.ts builds it, with Better Auth's test helpers added.
  ({ app, auth, outbox } = await composeApi({ db, config }, [testUtils()]));
  // The plugin is passed in at runtime, so the type of `$context` does not know about it.
  test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
});

afterEach(async () => {
  // As main.ts does: the worker ends its pass before the database closes.
  await outbox.stop();
  vi.restoreAllMocks();
  await closeDatabase();
});

async function signIn(email: string, name: string) {
  const user = await test.saveUser(test.createUser({ email, name, emailVerified: true }));
  return test.login({ userId: user.id });
}

/** A request the web app's proxy forwards: from the web origin, with the client's address. */
function fromBrowser(headers?: HeadersInit): Headers {
  const forwarded = new Headers(headers);
  forwarded.set('origin', WEB_ORIGIN);
  forwarded.set('content-type', 'application/json');
  forwarded.set('x-forwarded-for', clientIp);
  return forwarded;
}

function startGoogleSignIn() {
  return app.request('/api/auth/sign-in/social', {
    method: 'POST',
    headers: fromBrowser(),
    body: JSON.stringify({ provider: 'google', callbackURL: '/', errorCallbackURL: '/' }),
  });
}

/**
 * Google's token endpoint, answering with an id token for `claims`. It is unsigned: Better Auth
 * only decodes the id token it gets back from the token endpoint.
 */
function stubGoogleToken(claims: Record<string, unknown>) {
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
  const idToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    iss: 'https://accounts.google.com',
    aud: config.google.clientId,
    ...claims,
  })}.`;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://oauth2.googleapis.com/token')) {
      throw new Error(`The test made an unexpected request to ${url}`);
    }
    return Response.json({
      access_token: 'sprocket-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid email profile',
      id_token: idToken,
    });
  });
}

type GoogleSignIn = { state: string; cookie: string };

/** Starts Google sign-in the way the web app does, keeping what the browser brings back. */
async function beginGoogleSignIn(): Promise<GoogleSignIn> {
  const started = await startGoogleSignIn();
  const { url } = (await started.json()) as { url: string };
  return {
    state: new URL(url).searchParams.get('state') ?? '',
    cookie: started.headers
      .getSetCookie()
      .map((setCookie) => setCookie.split(';')[0])
      .join('; '),
  };
}

/** Google sending the browser back to the callback: where the browser is sent next. */
async function returnFromGoogle(signIn: GoogleSignIn) {
  const response = await app.request(
    `/api/auth/callback/google?code=sprocket-code&state=${encodeURIComponent(signIn.state)}`,
    { headers: { cookie: signIn.cookie, 'x-forwarded-for': clientIp } },
  );
  const location = response.headers.get('location');
  return { status: response.status, location: location ? new URL(location, WEB_ORIGIN) : null };
}

/** Better Auth logs each state it cannot read; the tests that send one expect that line. */
function expectStateLogged() {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () =>
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse state'),
      expect.anything(),
    );
}

/**
 * A route's answer, checked against the contract: its status must be one the route declares,
 * and its body must match that status's schema, with no field the contract does not name.
 */
async function answerOf(method: string, path: string, response: Response) {
  const body: unknown = await response.json();
  const route = ROUTES.find((r) => r.method === method.toLowerCase() && r.path === path);
  expect(route, `${method} ${path} is in the contract`).toBeDefined();
  const responses = (route?.responses ?? {}) as Record<number, ContractResponse | undefined>;
  const declared = responses[response.status];
  expect(declared, `${method} ${path} declares ${response.status}`).toBeDefined();
  const parsed = declared?.content['application/json'].schema.safeParse(body);
  expect(
    parsed?.error,
    `${method} ${path} ${response.status} matches the contract`,
  ).toBeUndefined();
  // biome-ignore lint/suspicious/noExplicitAny: the tests read bodies by their fields.
  return { status: response.status, body: body as any };
}

type ContractResponse = {
  content: { 'application/json': { schema: { safeParse(value: unknown): { error?: unknown } } } };
};

async function get(path: string, headers?: Headers) {
  return answerOf('GET', path, await app.request(path, { headers }));
}

/** A change the web app sends: a JSON body, from the web origin, as `headers`' session. */
async function send(method: 'POST' | 'PUT', path: string, body: unknown, headers?: Headers) {
  const response = await app.request(path, {
    method,
    headers: fromBrowser(headers),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return answerOf(method, path, response);
}

const acme = { name: 'Acme', slug: 'acme', region: 'eu' };

/** Makes a workspace as `headers`' session, failing the test unless it is made. */
async function makeWorkspace(headers: Headers, request: Record<string, unknown> = acme) {
  const made = await send('POST', '/api/workspaces', request, headers);
  expect(made.status).toBe(201);
  return made.body as { id: string; name: string; slug: string; region: string; role: string };
}

/** The workspace rows as stored, for checks that a route changed nothing. */
function storedWorkspaces() {
  return db
    .select({
      id: schema.organization.id,
      name: schema.organization.name,
      slug: schema.organization.slug,
      region: schema.organization.region,
    })
    .from(schema.organization);
}

describe('who is signed in', () => {
  it('GET /api/me is 401 signed out', async () => {
    expect(await get('/api/me')).toEqual({ status: 401, body: { error: 'signed_out' } });
  });

  it('someone who has made no workspace is signed in, in none', async () => {
    const login = await signIn('dana@acme.test', 'Dana Ortiz');
    expect(await get('/api/me', login.headers)).toEqual({
      status: 200,
      body: {
        user: { id: login.user.id, name: 'Dana Ortiz', email: 'dana@acme.test', image: null },
        workspace: null,
      },
    });
  });

  it('signing in joins no workspace', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    await makeWorkspace(dana.headers);
    await signIn('lee@sprocket.test', 'Lee Park');
    expect(await db.select().from(schema.member)).toEqual([
      expect.objectContaining({ userId: dana.user.id, role: 'owner' }),
    ]);
  });

  it('a person no longer in their active workspace is in none', async () => {
    const login = await signIn('dana@acme.test', 'Dana Ortiz');
    await makeWorkspace(login.headers);
    await db.delete(schema.member).where(eq(schema.member.userId, login.user.id));
    expect((await get('/api/me', login.headers)).body.workspace).toBeNull();
  });

  it('an unverified email cannot create an account', async () => {
    await expect(
      test.saveUser(test.createUser({ email: 'sam@sprocket.test', emailVerified: false })),
    ).rejects.toThrow('A verified email address is required.');
    expect(await db.select().from(schema.user)).toEqual([]);
  });

  it('a person whose email is no longer verified gets no session', async () => {
    const dana = await test.saveUser(
      test.createUser({ email: 'dana@sprocket.test', name: 'Dana Ortiz', emailVerified: true }),
    );
    await db.update(schema.user).set({ emailVerified: false }).where(eq(schema.user.id, dana.id));
    await expect(test.login({ userId: dana.id })).rejects.toThrow(
      'A verified email address is required.',
    );
    expect(await db.select().from(schema.session)).toEqual([]);
  });
});

describe('workspaces', () => {
  it('every workspace route is 401 signed out', async () => {
    expect(await get('/api/workspaces')).toEqual({ status: 401, body: { error: 'signed_out' } });
    expect(await send('POST', '/api/workspaces', acme)).toEqual({
      status: 401,
      body: { error: 'signed_out' },
    });
    expect(await send('PUT', '/api/me/workspace', { workspaceId: 'any' })).toEqual({
      status: 401,
      body: { error: 'signed_out' },
    });
    expect(await storedWorkspaces()).toEqual([]);
  });

  it('a person makes a workspace, owns it and is in it', async () => {
    const login = await signIn('dana@acme.test', 'Dana Ortiz');
    const made = await send('POST', '/api/workspaces', { ...acme, region: 'us' }, login.headers);
    expect(made).toEqual({
      status: 201,
      body: {
        id: expect.any(String),
        name: 'Acme',
        slug: 'acme',
        region: 'us',
        role: 'owner',
        icon: null,
        canManage: true,
      },
    });
    expect((await get('/api/me', login.headers)).body.workspace).toEqual(made.body);
    expect(await get('/api/workspaces', login.headers)).toEqual({
      status: 200,
      body: { workspaces: [made.body] },
    });
  });

  it('two people each make a workspace and see only their own', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const lee = await signIn('lee@sprocket.test', 'Lee Park');
    const danas = await makeWorkspace(dana.headers, acme);
    const lees = await makeWorkspace(lee.headers, {
      name: 'Sprocket',
      slug: 'sprocket',
      region: 'us',
    });

    expect((await get('/api/workspaces', dana.headers)).body).toEqual({ workspaces: [danas] });
    expect((await get('/api/workspaces', lee.headers)).body).toEqual({ workspaces: [lees] });
    expect((await get('/api/me', dana.headers)).body.workspace).toEqual(danas);
    expect((await get('/api/me', lee.headers)).body.workspace).toEqual(lees);
  });

  it('a slug that is taken is refused, in any region', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const lee = await signIn('lee@sprocket.test', 'Lee Park');
    await makeWorkspace(dana.headers, acme);

    for (const region of ['eu', 'us']) {
      expect(
        await send('POST', '/api/workspaces', { name: 'Acme', slug: 'acme', region }, lee.headers),
      ).toEqual({ status: 409, body: { error: 'slug_taken' } });
    }
    expect(await send('POST', '/api/workspaces', acme, dana.headers)).toEqual({
      status: 409,
      body: { error: 'slug_taken' },
    });
    expect(await storedWorkspaces()).toEqual([expect.objectContaining({ slug: 'acme' })]);
    expect((await get('/api/workspaces', lee.headers)).body).toEqual({ workspaces: [] });
    expect((await get('/api/me', lee.headers)).body.workspace).toBeNull();
  });

  it('a workspace the rules refuse is 400, naming every problem', async () => {
    const login = await signIn('dana@acme.test', 'Dana Ortiz');
    expect(
      await send(
        'POST',
        '/api/workspaces',
        { name: ' ', slug: 'Acme', region: 'ap' },
        login.headers,
      ),
    ).toEqual({
      status: 400,
      body: {
        error: 'invalid_workspace',
        problems: ['name_missing', 'slug_invalid', 'region_unknown'],
      },
    });
    // JSON of the wrong shape is a workspace with every problem; a body that is not JSON at all
    // is refused before the rules see it, as on every route.
    for (const body of ['[]', 'null', '{}']) {
      expect(await send('POST', '/api/workspaces', body, login.headers)).toEqual({
        status: 400,
        body: {
          error: 'invalid_workspace',
          problems: ['name_missing', 'slug_invalid', 'region_unknown'],
        },
      });
    }
    expect(await send('POST', '/api/workspaces', 'not json', login.headers)).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
    expect(await storedWorkspaces()).toEqual([]);
  });

  it('a person switches between their workspaces', async () => {
    const login = await signIn('dana@acme.test', 'Dana Ortiz');
    const first = await makeWorkspace(login.headers, acme);
    const second = await makeWorkspace(login.headers, { ...acme, slug: 'acme-labs' });
    expect((await get('/api/me', login.headers)).body.workspace).toEqual(second);

    expect(
      await send('PUT', '/api/me/workspace', { workspaceId: first.id }, login.headers),
    ).toEqual({ status: 200, body: first });
    expect((await get('/api/me', login.headers)).body.workspace).toEqual(first);
  });

  it('a workspace the person is not in is 404, like one that is not there', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const lee = await signIn('lee@sprocket.test', 'Lee Park');
    const danas = await makeWorkspace(dana.headers);

    for (const workspaceId of [danas.id, 'not-a-workspace']) {
      expect(await send('PUT', '/api/me/workspace', { workspaceId }, lee.headers)).toEqual({
        status: 404,
        body: { error: 'workspace_not_found' },
      });
    }
    expect((await get('/api/me', lee.headers)).body.workspace).toBeNull();
  });

  it('switching needs a workspace id', async () => {
    const login = await signIn('dana@acme.test', 'Dana Ortiz');
    for (const body of [{}, { workspaceId: 7 }, 'not json']) {
      expect(await send('PUT', '/api/me/workspace', body, login.headers)).toEqual({
        status: 400,
        body: { error: 'invalid_request' },
      });
    }
  });

  it('a body must be sent as JSON', async () => {
    const login = await signIn('dana@acme.test', 'Dana Ortiz');
    for (const contentType of ['text/plain;charset=UTF-8', null]) {
      const headers = fromBrowser(login.headers);
      if (contentType === null) headers.delete('content-type');
      else headers.set('content-type', contentType);
      const response = await app.request('/api/workspaces', {
        method: 'POST',
        headers,
        body: JSON.stringify(acme),
      });
      expect(await answerOf('POST', '/api/workspaces', response)).toEqual({
        status: 415,
        body: { error: 'unsupported_media_type' },
      });
    }
    expect(await storedWorkspaces()).toEqual([]);
  });

  it('signed out is 401 whatever the body', async () => {
    for (const body of ['not json', '{}', { workspaceId: 7 }]) {
      expect(await send('PUT', '/api/me/workspace', body)).toEqual({
        status: 401,
        body: { error: 'signed_out' },
      });
      expect(await send('POST', '/api/workspaces', body)).toEqual({
        status: 401,
        body: { error: 'signed_out' },
      });
    }
  });

  it('a new session opens the workspace the person last had active', async () => {
    const first = await signIn('dana@acme.test', 'Dana Ortiz');
    const acmeWorkspace = await makeWorkspace(first.headers, acme);
    await makeWorkspace(first.headers, { ...acme, slug: 'acme-labs' });
    await send('PUT', '/api/me/workspace', { workspaceId: acmeWorkspace.id }, first.headers);

    const again = await test.login({ userId: first.user.id });
    expect((await get('/api/me', again.headers)).body.workspace).toEqual(acmeWorkspace);
  });

  it('a change from anywhere but the web app is refused', async () => {
    const login = await signIn('dana@acme.test', 'Dana Ortiz');
    for (const origin of ['http://localhost:3000', 'null', null]) {
      const headers = fromBrowser(login.headers);
      if (origin === null) headers.delete('origin');
      else headers.set('origin', origin);
      const response = await app.request('/api/workspaces', {
        method: 'POST',
        headers,
        body: JSON.stringify(acme),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'bad_origin' });
    }
    expect(await storedWorkspaces()).toEqual([]);
  });
});

describe('the cell token', () => {
  /** Asks for a cell token the way the web app does: a POST from its origin, as `headers`' session. */
  async function mint(headers?: Headers, body?: unknown) {
    const response = await app.request('/api/cell-token', {
      method: 'POST',
      headers: fromBrowser(headers),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cacheControl = response.headers.get('cache-control');
    return { ...(await answerOf('POST', '/api/cell-token', response)), cacheControl };
  }

  /** The published key set, fetched as a cell fetches it: with no sign-in. */
  async function publishedKeys(): Promise<JSONWebKeySet> {
    const answer = await get(CELL_TOKEN_KEYS_PATH);
    expect(answer.status).toBe(200);
    return answer.body;
  }

  /**
   * A token checked the way a cell checks it: its signature against the published keys, with
   * EdDSA alone and the cell's audience, then its claims with the contract's reader.
   */
  async function asACell(token: string) {
    const { payload, protectedHeader } = await jwtVerify(
      token,
      createLocalJWKSet(await publishedKeys()),
      {
        algorithms: [CELL_TOKEN_ALGORITHM],
        audience: CELL_TOKEN_AUDIENCE,
        clockTolerance: CLOCK_SKEW_SECONDS,
      },
    );
    const read = readCellTokenClaims(payload, Math.floor(Date.now() / 1000));
    if (!read.ok) throw new Error(`A cell refuses the token: ${read.reason}.`);
    return { claims: read.value, header: protectedHeader };
  }

  /** The claims of the token the session is minted now, as a cell reads them. */
  async function mintedClaims(headers: Headers) {
    const minted = await mint(headers);
    expect(minted.status).toBe(200);
    return (await asACell(minted.body.token)).claims;
  }

  it('is 401 signed out', async () => {
    expect(await mint()).toMatchObject({ status: 401, body: { error: 'signed_out' } });
  });

  it("is minted for the session's workspace, for minutes, and checks with the published keys", async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(login.headers, { ...acme, region: 'us' });

    const before = Math.floor(Date.now() / 1000);
    const minted = await mint(login.headers);
    const after = Math.floor(Date.now() / 1000);

    expect(minted).toEqual({
      status: 200,
      cacheControl: 'no-store',
      body: {
        token: expect.any(String),
        expiresAt: expect.any(Number),
        workspaceId: workspace.id,
        region: 'us',
      },
    });
    const { claims, header } = await asACell(minted.body.token);
    expect(claims).toEqual({
      aud: CELL_TOKEN_AUDIENCE,
      sub: login.user.id,
      ws: workspace.id,
      role: 'owner',
      region: 'us',
      iat: expect.any(Number),
      exp: minted.body.expiresAt,
    });
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.iat).toBeLessThanOrEqual(after);
    expect(claims.exp - claims.iat).toBe(CELL_TOKEN_LIFETIME_SECONDS);
    expect(CELL_TOKEN_LIFETIME_SECONDS).toBeLessThanOrEqual(10 * 60);
    expect(header).toEqual({ alg: 'EdDSA', kid: (await publishedKeys()).keys[0]?.kid });
  });

  it('names the region of the workspace the session has active, whichever it is', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    const inUs = await makeWorkspace(login.headers, { ...acme, region: 'us' });
    const inEu = await makeWorkspace(login.headers, {
      name: 'Acme Labs',
      slug: 'acme-labs',
      region: 'eu',
    });

    expect(await mintedClaims(login.headers)).toMatchObject({ ws: inEu.id, region: 'eu' });
    await send('PUT', '/api/me/workspace', { workspaceId: inUs.id }, login.headers);
    expect(await mintedClaims(login.headers)).toMatchObject({ ws: inUs.id, region: 'us' });
  });

  it('takes the workspace and the role from the database, never from the request', async () => {
    const dana = await signIn('dana@sprocket.test', 'Dana Ortiz');
    const acmeWorkspace = await makeWorkspace(dana.headers, acme);
    const lee = await signIn('lee@sprocket.test', 'Lee Park');
    const sprocket = await makeWorkspace(lee.headers, {
      name: 'Sprocket',
      slug: 'sprocket',
      region: 'us',
    });
    await db.insert(schema.member).values({
      id: 'm-dana-sprocket',
      organizationId: sprocket.id,
      userId: dana.user.id,
      role: 'member',
      createdAt: new Date(),
    });

    // Whatever the request says, the token is for the session's own workspace, as stored.
    const asked = await mint(dana.headers, {
      workspaceId: sprocket.id,
      ws: sprocket.id,
      sub: lee.user.id,
      role: 'owner',
      region: 'us',
    });
    expect((await asACell(asked.body.token)).claims).toMatchObject({
      sub: dana.user.id,
      ws: acmeWorkspace.id,
      role: 'owner',
      region: 'eu',
    });

    await send('PUT', '/api/me/workspace', { workspaceId: sprocket.id }, dana.headers);
    expect(await mintedClaims(dana.headers)).toMatchObject({ ws: sprocket.id, role: 'member' });
    await db
      .update(schema.member)
      .set({ role: 'admin' })
      .where(eq(schema.member.id, 'm-dana-sprocket'));
    expect(await mintedClaims(dana.headers)).toMatchObject({ ws: sprocket.id, role: 'admin' });
  });

  it('is 409 for a session with no active workspace', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    expect(await mint(login.headers)).toEqual({
      status: 409,
      cacheControl: null,
      body: { error: 'no_active_workspace' },
    });
  });

  it('is never minted for a workspace the person is not in', async () => {
    const dana = await signIn('dana@sprocket.test', 'Dana Ortiz');
    const danas = await makeWorkspace(dana.headers);
    const lee = await signIn('lee@sprocket.test', 'Lee Park');
    const notAMember = { status: 403, cacheControl: null, body: { error: 'not_a_member' } };

    // Lee's session names Dana's workspace, however it came to.
    await db
      .update(schema.session)
      .set({ activeOrganizationId: danas.id })
      .where(eq(schema.session.userId, lee.user.id));
    expect(await mint(lee.headers)).toEqual(notAMember);

    // Dana, once she is no longer in it, gets none either.
    await db.delete(schema.member).where(eq(schema.member.userId, dana.user.id));
    expect(await mint(dana.headers)).toEqual(notAMember);
  });

  it('is refused from anywhere but the web app', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    await makeWorkspace(login.headers);
    for (const origin of ['http://localhost:3000', null]) {
      const headers = fromBrowser(login.headers);
      if (origin === null) headers.delete('origin');
      else headers.set('origin', origin);
      const response = await app.request('/api/cell-token', { method: 'POST', headers });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'bad_origin' });
    }
  });

  it('publishes its public key to anyone, named by its thumbprint, and never the private key', async () => {
    const response = await app.request(CELL_TOKEN_KEYS_PATH);
    expect(response.status).toBe(200);
    const text = await response.text();

    const publicKey = { kty: 'OKP', crv: 'Ed25519', x: cellKey.x };
    expect(JSON.parse(text)).toEqual({
      keys: [
        { ...publicKey, kid: await calculateJwkThumbprint(publicKey), alg: 'EdDSA', use: 'sig' },
      ],
    });
    expect(text).not.toContain('"d"');
    expect(text).not.toContain(cellKey.d);
  });

  it('a key that is not a key pair stops the service from being built', async () => {
    const other = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    const failure = await composeApi({
      db,
      config: { ...config, cellTokenPrivateKey: { ...cellKey, x: String(other.x) } },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).problems).toEqual([
      expect.stringMatching(/^CELL_TOKEN_PRIVATE_KEY: /),
    ]);
    expect((failure as ConfigError).message).not.toContain(cellKey.d);
  });

  it('the private key is never logged', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );

    await composeApi({ db, config });
    await composeApi({ db, config: { ...config, cellTokenPrivateKey: { ...cellKey, x: 'x' } } })
      .then(() => {
        throw new Error('A key that is not a key pair was taken.');
      })
      .catch((error: unknown) => {
        if (!(error instanceof ConfigError)) throw error;
      });
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    expect((await mint(login.headers)).status).toBe(409);
    await makeWorkspace(login.headers);
    expect((await mint(login.headers)).status).toBe(200);
    await publishedKeys();

    const logged = logs
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((arg) => inspect(arg, { depth: 10 })).join(' '))
      .join('\n');
    expect(logged).not.toContain(cellKey.d);
  });
});

describe('the outbox', () => {
  type Delivery = { url: string; type: string | null; body: string };

  /** Every cell's address, answering 200 to every delivery and keeping each. */
  function cellsAnswering(): Delivery[] {
    const deliveries: Delivery[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (![ACME_CELL, SPROCKET_CELL].includes(new URL(request.url).origin)) {
        throw new Error(`The test made an unexpected request to ${request.url}`);
      }
      deliveries.push({
        url: request.url,
        type: request.headers.get('content-type'),
        body: await request.text(),
      });
      return Response.json({ applied: true });
    });
    return deliveries;
  }

  /** A delivery read the way a cell reads it: its signature against the published keys. */
  async function asACell(delivery: Delivery) {
    const response = await app.request(CELL_TOKEN_KEYS_PATH);
    const keys = (await response.json()) as JSONWebKeySet;
    const { payload, protectedHeader } = await compactVerify(
      delivery.body,
      createLocalJWKSet(keys),
      { algorithms: [CELL_TOKEN_ALGORITHM] },
    );
    expect(protectedHeader).toEqual({
      alg: CELL_TOKEN_ALGORITHM,
      kid: keys.keys[0]?.kid,
      typ: OUTBOX_MESSAGE_TYPE,
    });
    const json = new TextDecoder().decode(payload);
    expect(readOutboxMessage(JSON.parse(json)).ok).toBe(true);
    return json;
  }

  it("delivers a new workspace to its region's cell, signed, as ids and roles only", async () => {
    const deliveries = cellsAnswering();
    const logs = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const login = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(login.headers);

    // Built, as main.ts builds it, but not started: nothing has gone to any cell yet.
    expect(deliveries).toEqual([]);
    outbox.start();
    await vi.waitFor(() => expect(deliveries).toHaveLength(2));
    await outbox.stop();

    expect(deliveries.map(({ url, type }) => ({ url, type }))).toEqual([
      { url: `${ACME_CELL}${OUTBOX_DELIVERY_PATH}`, type: OUTBOX_DELIVERY_MEDIA_TYPE },
      { url: `${ACME_CELL}${OUTBOX_DELIVERY_PATH}`, type: OUTBOX_DELIVERY_MEDIA_TYPE },
    ]);
    const messages = [];
    for (const delivery of deliveries) messages.push(await asACell(delivery));
    expect(messages).toEqual([
      `{"workspaceId":"${workspace.id}","region":"eu","sequence":1,"change":{"type":"workspace.created"}}`,
      `{"workspaceId":"${workspace.id}","region":"eu","sequence":2,"change":{"type":"member.added","personId":"${login.user.id}","role":"owner"}}`,
    ]);
    for (const message of messages) {
      expect(message).not.toContain('dana@acme.test');
      expect(message).not.toContain('Dana');
      expect(message).not.toContain('Acme');
    }

    // The log names ids and statuses, never a signature or the key.
    const logged = logs
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((arg) => inspect(arg, { depth: 10 })).join(' '))
      .join('\n');
    expect(logged).toContain(`delivered message 2 of workspace ${workspace.id}`);
    for (const delivery of deliveries) expect(logged).not.toContain(delivery.body.split('.')[2]);
    expect(logged).not.toContain(cellKey.d);
  });

  it('wakes as a workspace is made, rather than at its next poll', async () => {
    const deliveries = cellsAnswering();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    outbox.start();
    const login = await signIn('lee@sprocket.test', 'Lee Park');

    // Sprocket is in the US, so its messages go to the US cell, and well inside the poll.
    const workspace = await makeWorkspace(login.headers, {
      name: 'Sprocket',
      slug: 'sprocket',
      region: 'us',
    });
    await vi.waitFor(() => expect(deliveries).toHaveLength(2), { timeout: 5_000 });

    expect(deliveries.map((delivery) => delivery.url)).toEqual([
      `${SPROCKET_CELL}${OUTBOX_DELIVERY_PATH}`,
      `${SPROCKET_CELL}${OUTBOX_DELIVERY_PATH}`,
    ]);
    expect(await asACell(deliveries[0] as Delivery)).toBe(
      `{"workspaceId":"${workspace.id}","region":"us","sequence":1,"change":{"type":"workspace.created"}}`,
    );
  });
});

describe('GET /api/me/workspace/members', () => {
  const path = '/api/me/workspace/members';

  it('is 401 signed out', async () => {
    expect(await get(path)).toEqual({ status: 401, body: { error: 'signed_out' } });
  });

  it('is 409 with no workspace open', async () => {
    const login = await signIn('dana@acme.test', 'Dana Ortiz');
    expect(await get(path, login.headers)).toEqual({
      status: 409,
      body: { error: 'no_active_workspace' },
    });
  });

  it("lists the active workspace's members, with their global ids and roles", async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(dana.headers);
    const lee = await signIn('lee@acme.test', 'Lee Park');
    await db.insert(schema.member).values({
      id: 'acme-lee',
      organizationId: workspace.id,
      userId: lee.user.id,
      role: 'member',
      createdAt: new Date(Date.now() + 1000),
    });

    const answer = await get(path, dana.headers);
    expect(answer.status).toBe(200);
    expect(answer.body.members).toEqual([
      { id: dana.user.id, name: 'Dana Ortiz', email: 'dana@acme.test', image: null, role: 'owner' },
      { id: lee.user.id, name: 'Lee Park', email: 'lee@acme.test', image: null, role: 'member' },
    ]);
  });

  it('lists no one for a session whose workspace the person has left', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(dana.headers);
    await db.delete(schema.member).where(eq(schema.member.organizationId, workspace.id));
    expect(await get(path, dana.headers)).toEqual({
      status: 403,
      body: { error: 'not_a_member' },
    });
  });
});

describe('GitHub as a connection', () => {
  // A key made for this run only, never one written down, in a folder of its own.
  const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  let keyFolder: string;
  let withGitHub: CloudConfig;

  /** Who GitHub says can reach which installations, by the code their redirect carries. */
  let reachable: Record<string, { id: number; login: string; type: string }[]>;
  /** The codes of people who are only members of the organisations they reach; others own them. */
  let membersOnly: Set<string>;
  let seen: { method: string; url: string; body: string }[];

  beforeAll(async () => {
    keyFolder = await mkdtemp(join(tmpdir(), 'consola-github-app-'));
    const privateKeyPath = join(keyFolder, 'app.pem');
    await writeFile(privateKeyPath, appKey.export({ type: 'pkcs1', format: 'pem' }));
    withGitHub = {
      ...config,
      github: {
        clientId: 'Iv23liSprocketTest',
        clientSecret: 'sprocket-test-github-client-secret',
        slug: 'consola-dev',
        privateKeyPath,
      },
    };
  });

  afterAll(async () => {
    await rm(keyFolder, { recursive: true, force: true });
  });

  /** GitHub, as Consola's app talks to it, behind `fetch`. */
  function fakeGitHub() {
    seen = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = typeof init?.body === 'string' ? init.body : '';
      const method = init?.method ?? 'GET';
      seen.push({ method, url: url.toString(), body });
      const headers = new Headers(init?.headers);
      const route = `${method} ${url.origin}${url.pathname}`;

      if (route === 'POST https://github.com/login/oauth/access_token') {
        const { code } = JSON.parse(body) as { code: string };
        return reachable[code]
          ? Response.json({ access_token: `ghu_${code}`, token_type: 'bearer' })
          : Response.json({ error: 'bad_verification_code' });
      }
      // The person a token is for: whoever's code it was exchanged for.
      const code = headers.get('authorization')?.replace('Bearer ghu_', '') ?? '';
      if (route === 'GET https://api.github.com/user/installations') {
        const installations = (reachable[code] ?? []).map(({ id, login, type }) => ({
          id,
          account: { id: id + 1000, login, type },
          repository_selection: 'selected',
        }));
        return Response.json({ total_count: installations.length, installations });
      }
      if (route === 'GET https://api.github.com/user') {
        return Response.json({ id: code.length, login: code });
      }
      if (url.pathname.startsWith('/user/memberships/orgs/')) {
        return Response.json({
          state: 'active',
          role: membersOnly.has(code) ? 'member' : 'admin',
        });
      }
      if (route === 'DELETE https://api.github.com/applications/Iv23liSprocketTest/token') {
        return new Response(null, { status: 204 });
      }
      const mint =
        /^POST https:\/\/api\.github\.com\/app\/installations\/(\d+)\/access_tokens$/.exec(route);
      if (mint) {
        return Response.json(
          { token: `ghs_installation_${mint[1]}`, expires_at: '2099-01-01T00:00:00Z' },
          { status: 201 },
        );
      }
      if (route === 'GET https://api.github.com/installation/repositories') {
        const installation = headers.get('authorization')?.replace('Bearer ghs_installation_', '');
        return Response.json({
          total_count: 1,
          repositories: [
            {
              id: Number(installation) * 10,
              full_name: `sprocket/catalog-portal-${installation}`,
              private: true,
              html_url: `https://github.com/sprocket/catalog-portal-${installation}`,
            },
          ],
        });
      }
      throw new Error(`The test made an unexpected request to ${method} ${url}`);
    });
  }

  beforeEach(async () => {
    reachable = {};
    membersOnly = new Set();
    ({ app, auth } = await composeApi({ db, config: withGitHub }, [testUtils()]));
    test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
    fakeGitHub();
  });

  async function startConnect(headers: Headers) {
    const response = await app.request('/api/connections/github/install', {
      method: 'POST',
      headers: fromBrowser(headers),
    });
    const answer = await answerOf('POST', '/api/connections/github/install', response);
    return { ...answer, headers: response.headers };
  }

  /** Disconnects installation `id` as the web app does; an answer with a body is checked. */
  async function disconnect(id: string, headers: Headers, from = fromBrowser(headers)) {
    const response = await app.request(`/api/connections/github/installations/${id}`, {
      method: 'DELETE',
      headers: from,
    });
    if (response.status === 204) return { status: 204, body: null };
    return answerOf('DELETE', '/api/connections/github/installations/{installationId}', response);
  }

  /** GitHub sending the browser back: where the browser goes next, and with what result. */
  async function returnFromGitHub(headers: Headers, query: Record<string, string>) {
    const response = await app.request(
      `/api/github/callback?${new URLSearchParams(query).toString()}`,
      { headers },
    );
    const location = response.headers.get('location') ?? '';
    return {
      status: response.status,
      location,
      result: new URL(location).searchParams.get('github'),
      headers: response.headers,
    };
  }

  /** A whole Connect: Consola's install link, then GitHub's redirect back with `code`. */
  async function connect(headers: Headers, installationId: number, code: string) {
    const started = await startConnect(headers);
    expect(started.status).toBe(200);
    const state = new URL(started.body.url).searchParams.get('state') ?? '';
    return returnFromGitHub(headers, {
      code,
      installation_id: String(installationId),
      setup_action: 'install',
      state,
    });
  }

  async function addMember(workspaceId: string, userId: string, role: string) {
    await db.insert(schema.member).values({
      id: `m-${workspaceId}-${userId}`,
      organizationId: workspaceId,
      userId,
      role,
      createdAt: new Date(),
    });
  }

  it('every route is 401 signed out, and the callback sends the browser back signed out', async () => {
    expect(await get('/api/connections')).toEqual({ status: 401, body: { error: 'signed_out' } });
    expect((await startConnect(new Headers())).status).toBe(401);
    expect(await disconnect('41', new Headers())).toEqual({
      status: 401,
      body: { error: 'signed_out' },
    });
    expect((await returnFromGitHub(new Headers(), { code: 'x' })).result).toBe('signed_out');
  });

  it('an owner connects GitHub, and the page shows the installation and its repositories', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(login.headers);
    reachable = { 'dana-code': [{ id: 41, login: 'sprocket', type: 'Organization' }] };

    const started = await startConnect(login.headers);
    expect(started.status).toBe(200);
    expect(started.headers.get('cache-control')).toBe('no-store');
    const url = new URL(started.body.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://github.com/apps/consola-dev/installations/new',
    );

    const back = await returnFromGitHub(login.headers, {
      code: 'dana-code',
      installation_id: '41',
      setup_action: 'install',
      state: url.searchParams.get('state') ?? '',
    });
    expect(back.status).toBe(302);
    expect(back.location).toBe(`${WEB_ORIGIN}/?github=connected#/settings/connections`);
    expect(back.headers.get('referrer-policy')).toBe('no-referrer');

    expect(await get('/api/connections', login.headers)).toEqual({
      status: 200,
      body: {
        canManage: true,
        github: {
          configured: true,
          installations: [
            {
              id: 41,
              account: { id: 1041, login: 'sprocket', type: 'Organization' },
              connectedAt: expect.any(String),
              settingsUrl: 'https://github.com/organizations/sprocket/settings/installations/41',
              repositories: {
                kind: 'listed',
                repositories: [
                  {
                    id: 410,
                    fullName: 'sprocket/catalog-portal-41',
                    private: true,
                    url: 'https://github.com/sprocket/catalog-portal-41',
                  },
                ],
              },
            },
          ],
        },
      },
    });
    const [row] = await db.select().from(schema.githubInstallation);
    expect(row).toMatchObject({
      installationId: 41,
      organizationId: workspace.id,
      connectedBy: login.user.id,
    });
    // The person's token was revoked once read.
    expect(
      seen.some((call) => call.method === 'DELETE' && call.body.includes('ghu_dana-code')),
    ).toBe(true);
  });

  it('a second workspace cannot claim an installation another workspace holds', async () => {
    const dana = await signIn('dana@sprocket.test', 'Dana Ortiz');
    await makeWorkspace(dana.headers);
    const lee = await signIn('lee@catalog.test', 'Lee Park');
    await makeWorkspace(lee.headers, { name: 'Catalog', slug: 'catalog', region: 'us' });
    reachable = {
      'dana-code': [{ id: 41, login: 'sprocket', type: 'Organization' }],
      'lee-code': [{ id: 41, login: 'sprocket', type: 'Organization' }],
    };

    expect((await connect(dana.headers, 41, 'dana-code')).result).toBe('connected');
    expect((await connect(lee.headers, 41, 'lee-code')).result).toBe('taken');

    const forLee = await get('/api/connections', lee.headers);
    expect(forLee.body.github.installations).toEqual([]);
    const forDana = await get('/api/connections', dana.headers);
    expect(forDana.body.github.installations).toHaveLength(1);
  });

  it('refuses an installation GitHub does not list for the person, whatever the address says', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    await makeWorkspace(login.headers);
    reachable = { 'dana-code': [{ id: 52, login: 'dana', type: 'User' }] };

    expect((await connect(login.headers, 41, 'dana-code')).result).toBe('not_installer');
    expect(await db.select().from(schema.githubInstallation)).toEqual([]);
  });

  it("refuses an organisation's installation to a member of it who does not own it", async () => {
    // Mallory can read one of sprocket's repositories, so GitHub lists its installation for her.
    const mallory = await signIn('mallory@catalog.test', 'Mallory');
    await makeWorkspace(mallory.headers, { name: 'Catalog', slug: 'catalog', region: 'eu' });
    reachable = { 'mallory-code': [{ id: 41, login: 'sprocket', type: 'Organization' }] };
    membersOnly = new Set(['mallory-code']);

    expect((await connect(mallory.headers, 41, 'mallory-code')).result).toBe('not_account_admin');
    expect(await db.select().from(schema.githubInstallation)).toEqual([]);

    // So the company's own owner can still connect it.
    const dana = await signIn('dana@sprocket.test', 'Dana Ortiz');
    await makeWorkspace(dana.headers);
    reachable['dana-code'] = [{ id: 41, login: 'sprocket', type: 'Organization' }];
    expect((await connect(dana.headers, 41, 'dana-code')).result).toBe('connected');
  });

  it('refuses a Connect another person started, and never spends their code', async () => {
    const dana = await signIn('dana@sprocket.test', 'Dana Ortiz');
    await makeWorkspace(dana.headers);
    const mallory = await signIn('mallory@catalog.test', 'Mallory');
    await makeWorkspace(mallory.headers, { name: 'Catalog', slug: 'catalog', region: 'eu' });
    reachable = { 'mallory-code': [{ id: 41, login: 'sprocket', type: 'Organization' }] };

    // Mallory's own link, opened in Dana's browser, connects nothing to Dana's workspace.
    const started = await startConnect(mallory.headers);
    const state = new URL(started.body.url).searchParams.get('state') ?? '';
    const back = await returnFromGitHub(dana.headers, {
      code: 'mallory-code',
      installation_id: '41',
      state,
    });
    expect(back.result).toBe('bad_state');
    expect(seen.filter((call) => call.url.includes('oauth/access_token'))).toEqual([]);
    expect(await db.select().from(schema.githubInstallation)).toEqual([]);
  });

  it('a member sees what is connected, and can neither connect nor disconnect', async () => {
    const dana = await signIn('dana@sprocket.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(dana.headers);
    reachable = { 'dana-code': [{ id: 41, login: 'sprocket', type: 'Organization' }] };
    await connect(dana.headers, 41, 'dana-code');

    const lee = await signIn('lee@sprocket.test', 'Lee Park');
    await addMember(workspace.id, lee.user.id, 'member');
    await send('PUT', '/api/me/workspace', { workspaceId: workspace.id }, lee.headers);

    const listed = await get('/api/connections', lee.headers);
    expect(listed.status).toBe(200);
    expect(listed.body.canManage).toBe(false);
    expect(listed.body.github.installations).toHaveLength(1);

    expect(await startConnect(lee.headers)).toMatchObject({
      status: 403,
      body: { error: 'not_allowed' },
    });
    expect(await disconnect('41', lee.headers)).toEqual({
      status: 403,
      body: { error: 'not_allowed' },
    });
    expect(await db.select().from(schema.githubInstallation)).toHaveLength(1);
  });

  it('disconnecting removes the record, and leaves the app installed on GitHub', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    await makeWorkspace(login.headers);
    reachable = { 'dana-code': [{ id: 41, login: 'sprocket', type: 'Organization' }] };
    await connect(login.headers, 41, 'dana-code');
    seen = [];

    expect((await disconnect('41', login.headers)).status).toBe(204);
    expect(await db.select().from(schema.githubInstallation)).toEqual([]);
    expect((await get('/api/connections', login.headers)).body.github.installations).toEqual([]);
    expect(seen).toEqual([]);

    expect(await disconnect('41', login.headers)).toEqual({
      status: 404,
      body: { error: 'installation_not_found' },
    });
    expect(await disconnect('41x', login.headers)).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
  });

  it('starting and disconnecting are refused from anywhere but the web app', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    await makeWorkspace(login.headers);
    const elsewhere = new Headers(login.headers);
    elsewhere.set('origin', 'http://localhost:6006');

    const started = await app.request('/api/connections/github/install', {
      method: 'POST',
      headers: elsewhere,
    });
    expect(await answerOf('POST', '/api/connections/github/install', started)).toEqual({
      status: 403,
      body: { error: 'bad_origin' },
    });
    expect(await disconnect('41', login.headers, elsewhere)).toEqual({
      status: 403,
      body: { error: 'bad_origin' },
    });
  });

  it('needs an active workspace', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    expect(await get('/api/connections', login.headers)).toEqual({
      status: 409,
      body: { error: 'no_active_workspace' },
    });
    expect((await startConnect(login.headers)).status).toBe(409);
  });

  it('without the GitHub App configured, nothing can be connected', async () => {
    ({ app, auth } = await composeApi({ db, config }, [testUtils()]));
    test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    await makeWorkspace(login.headers);

    expect(await get('/api/connections', login.headers)).toEqual({
      status: 200,
      body: { canManage: true, github: { configured: false, installations: [] } },
    });
    expect(await startConnect(login.headers)).toMatchObject({
      status: 503,
      body: { error: 'github_not_configured' },
    });
    expect((await returnFromGitHub(login.headers, { code: 'x' })).result).toBe('not_configured');
  });

  it('a key file that is not there stops the service from being built', async () => {
    const github = { ...(withGitHub.github as NonNullable<CloudConfig['github']>) };
    github.privateKeyPath = join(keyFolder, 'missing.pem');
    const failure = await composeApi({ db, config: { ...withGitHub, github } }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).problems).toEqual([
      expect.stringMatching(/^GITHUB_APP_PRIVATE_KEY_PATH: cannot read .*missing\.pem \(ENOENT\)$/),
    ]);
  });

  it("never logs the app's secrets, a person's code or a token", async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    await makeWorkspace(login.headers);
    reachable = { 'dana-code': [{ id: 41, login: 'sprocket', type: 'Organization' }] };
    await connect(login.headers, 41, 'dana-code');
    await connect(login.headers, 41, 'used-code');
    await get('/api/connections', login.headers);

    const logged = logs
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((arg) => inspect(arg, { depth: 10 })).join(' '))
      .join('\n');
    for (const secret of [
      withGitHub.github?.clientSecret ?? '',
      'dana-code',
      'ghu_',
      'ghs_',
      appKey.export({ type: 'pkcs1', format: 'pem' }).toString().split('\n')[1] ?? '',
    ]) {
      expect(secret).not.toBe('');
      expect(logged).not.toContain(secret);
    }
  });
});

describe('PUT /api/me/workspace/icon', () => {
  const path = '/api/me/workspace/icon';

  it('is 401 signed out', async () => {
    expect(await send('PUT', path, { icon: 'rocket' })).toEqual({
      status: 401,
      body: { error: 'signed_out' },
    });
  });

  it('is 409 with no workspace open', async () => {
    const login = await signIn('dana@acme.test', 'Dana Ortiz');
    expect(await send('PUT', path, { icon: 'rocket' }, login.headers)).toEqual({
      status: 409,
      body: { error: 'no_active_workspace' },
    });
  });

  it("sets the active workspace's icon for its owner, and every answer then wears it", async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(dana.headers);
    expect(workspace).toMatchObject({ icon: null, canManage: true });

    const set = await send('PUT', path, { icon: 'emoji-fox' }, dana.headers);
    expect(set).toEqual({ status: 200, body: { ...workspace, icon: 'emoji-fox' } });
    expect((await get('/api/me', dana.headers)).body.workspace).toEqual(set.body);
    expect((await get('/api/workspaces', dana.headers)).body.workspaces).toEqual([set.body]);
    expect(await storedWorkspaces()).toEqual([
      { id: workspace.id, name: 'Acme', slug: 'acme', region: 'eu' },
    ]);
  });

  it('takes the icon off with null', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(dana.headers);
    await send('PUT', path, { icon: 'rocket' }, dana.headers);
    expect(await send('PUT', path, { icon: null }, dana.headers)).toEqual({
      status: 200,
      body: { ...workspace, icon: null },
    });
  });

  it('refuses an icon outside the set, and a body of the wrong shape', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    await makeWorkspace(dana.headers);
    for (const icon of ['', 'unicorn', 'https://example.test/logo.png']) {
      expect(await send('PUT', path, { icon }, dana.headers)).toEqual({
        status: 400,
        body: { error: 'icon_unknown' },
      });
    }
    for (const body of [{}, { icon: 7 }]) {
      expect(await send('PUT', path, body, dana.headers)).toEqual({
        status: 400,
        body: { error: 'invalid_request' },
      });
    }
  });

  it('is 403 for a member, who may see the icon but not change it', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(dana.headers);
    await send('PUT', path, { icon: 'leaf' }, dana.headers);
    const lee = await signIn('lee@acme.test', 'Lee Park');
    await db.insert(schema.member).values({
      id: 'acme-lee',
      organizationId: workspace.id,
      userId: lee.user.id,
      role: 'member',
      createdAt: new Date(Date.now() + 1000),
    });
    await send('PUT', '/api/me/workspace', { workspaceId: workspace.id }, lee.headers);

    expect((await get('/api/me', lee.headers)).body.workspace).toMatchObject({
      icon: 'leaf',
      role: 'member',
      canManage: false,
    });
    expect(await send('PUT', path, { icon: 'moon' }, lee.headers)).toEqual({
      status: 403,
      body: { error: 'not_allowed' },
    });
    expect((await get('/api/me', dana.headers)).body.workspace.icon).toBe('leaf');
  });

  it('is 403 for a session whose workspace the person has left', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(dana.headers);
    await db.delete(schema.member).where(eq(schema.member.organizationId, workspace.id));
    expect(await send('PUT', path, { icon: 'moon' }, dana.headers)).toEqual({
      status: 403,
      body: { error: 'not_a_member' },
    });
  });

  it('reads a logo it did not write as no icon', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(dana.headers);
    await db
      .update(schema.organization)
      .set({ logo: 'https://example.test/logo.png' })
      .where(eq(schema.organization.id, workspace.id));
    expect((await get('/api/me', dana.headers)).body.workspace.icon).toBeNull();
  });
});

describe('GitHub tokens for a cell', () => {
  // A key made for this run only, never one written down, in a folder of its own.
  const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  let keyFolder: string;
  let withGitHub: CloudConfig;

  beforeAll(async () => {
    keyFolder = await mkdtemp(join(tmpdir(), 'consola-github-tokens-'));
    const privateKeyPath = join(keyFolder, 'app.pem');
    await writeFile(privateKeyPath, appKey.export({ type: 'pkcs1', format: 'pem' }));
    withGitHub = {
      ...config,
      github: {
        clientId: 'Iv23liSprocketTest',
        clientSecret: 'sprocket-test-github-client-secret',
        slug: 'consola-dev',
        privateKeyPath,
      },
    };
  });

  afterAll(async () => {
    await rm(keyFolder, { recursive: true, force: true });
  });

  /** What each installation covers on GitHub: Acme's 41, Bolt's 42 and Sprocket's 52. */
  const COVERED: Record<number, { id: number; full_name: string }[]> = {
    41: [
      { id: 410, full_name: 'acme/catalog-portal' },
      { id: 411, full_name: 'acme/api' },
    ],
    42: [{ id: 420, full_name: 'bolt/site' }],
    52: [{ id: 520, full_name: 'sprocket/factory' }],
  };

  /**
   * GitHub's answers, as recorded against GitHub on 2026-11-22 with the development app (names
   * changed): a token minted with `repository_ids` carries exactly those repositories and the
   * permissions asked, plus metadata read; it reads its own repository (200) and gets 404 for
   * every other private repository of the same installation; a repository the installation does
   * not cover is 422; and a revoked token is 401.
   */
  const RECORDED = {
    notFound: {
      message: 'Not Found',
      documentation_url: 'https://docs.github.com/rest',
      status: '404',
    },
    notAccessible: {
      message:
        'There is at least one repository that does not exist or is not accessible to the parent installation.',
      documentation_url:
        'https://docs.github.com/rest/apps/apps#create-an-installation-access-token-for-an-app',
      status: '422',
    },
  };

  let tokens: Map<string, { installationId: number; repositoryIds: number[] }>;
  let mintBodies: unknown[];
  let revoked: string[];
  /** When set, what GitHub answers a narrowed mint instead. */
  let mintAnswer: ((installationId: number) => Response) | null;

  /** GitHub, as minting talks to it, behind `fetch`, answering as recorded. */
  function fakeGitHub() {
    tokens = new Map();
    mintBodies = [];
    revoked = [];
    mintAnswer = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? 'GET';
      const route = `${method} ${url.origin}${url.pathname}`;
      const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
      const mint =
        /^POST https:\/\/api\.github\.com\/app\/installations\/(\d+)\/access_tokens$/.exec(route);
      if (mint) {
        const installationId = Number(mint[1]);
        const body = JSON.parse(String(init?.body)) as {
          repository_ids?: number[];
          permissions: Record<string, string>;
        };
        if (!body.repository_ids) {
          // The metadata token the repositories are listed with.
          return Response.json(
            { token: `ghs_listing_${installationId}`, expires_at: '2099-01-01T00:00:00Z' },
            { status: 201 },
          );
        }
        mintBodies.push(body);
        if (mintAnswer) return mintAnswer(installationId);
        const covered = COVERED[installationId] ?? [];
        const repositories = body.repository_ids.map((id) => covered.find((r) => r.id === id));
        if (repositories.some((repository) => !repository)) {
          return Response.json(RECORDED.notAccessible, { status: 422 });
        }
        const minted = `ghs_narrowed_${tokens.size + 1}`;
        tokens.set(minted, { installationId, repositoryIds: body.repository_ids });
        return Response.json(
          {
            token: minted,
            expires_at: '2099-01-01T00:00:00Z',
            permissions: { ...body.permissions, metadata: 'read' },
            repository_selection: 'selected',
            repositories,
          },
          { status: 201 },
        );
      }
      if (route === 'GET https://api.github.com/installation/repositories') {
        const installationId = Number(token.replace('ghs_listing_', ''));
        const repositories = (COVERED[installationId] ?? []).map((repository) => ({
          ...repository,
          private: true,
          html_url: `https://github.com/${repository.full_name}`,
        }));
        return Response.json({ total_count: repositories.length, repositories });
      }
      const read = /^GET https:\/\/api\.github\.com\/repositories\/(\d+)$/.exec(route);
      if (read) {
        const scope = tokens.get(token);
        if (!scope) return Response.json({ message: 'Bad credentials' }, { status: 401 });
        return scope.repositoryIds.includes(Number(read[1]))
          ? Response.json({ id: Number(read[1]) })
          : Response.json(RECORDED.notFound, { status: 404 });
      }
      if (route === 'DELETE https://api.github.com/installation/token') {
        revoked.push(token);
        tokens.delete(token);
        return new Response(null, { status: 204 });
      }
      throw new Error(`The test made an unexpected request to ${method} ${url}`);
    });
  }

  /** A read of a repository by id with `token`, as a cell would make it on GitHub. */
  async function readRepository(token: string, id: number) {
    const response = await fetch(`https://api.github.com/repositories/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return response.status;
  }

  let workspaceIds: { acme: string; bolt: string; sprocket: string };

  beforeEach(async () => {
    ({ app, auth } = await composeApi({ db, config: withGitHub }, [testUtils()]));
    test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const lee = await signIn('lee@bolt.test', 'Lee Park');
    const acmeMade = await makeWorkspace(dana.headers, acme);
    const sprocketMade = await makeWorkspace(dana.headers, {
      name: 'Sprocket',
      slug: 'sprocket',
      region: 'us',
    });
    const boltMade = await makeWorkspace(lee.headers, { name: 'Bolt', slug: 'bolt', region: 'eu' });
    workspaceIds = { acme: acmeMade.id, bolt: boltMade.id, sprocket: sprocketMade.id };
    const holds = (installationId: number, organizationId: string, login: string) => ({
      installationId,
      organizationId,
      accountId: installationId + 9000,
      accountLogin: login,
      accountType: 'Organization',
      connectedAt: new Date(),
    });
    await db
      .insert(schema.githubInstallation)
      .values([
        holds(41, acmeMade.id, 'acme'),
        holds(42, boltMade.id, 'bolt'),
        holds(52, sprocketMade.id, 'sprocket'),
      ]);
    fakeGitHub();
  });

  /** A request as a cell signs it, with its own key: Acme's catalog portal, to pull, by default. */
  async function signedBy(
    cell: { privateKey: KeyObject; publicJwk: Ed25519PublicJwk },
    ask: Partial<GitHubTokenAsk> = {},
  ) {
    const request = gitHubTokenRequest({
      workspaceId: workspaceIds.acme,
      installationId: 41,
      purpose: 'factory-pull',
      repositoryIds: [410],
      issuedAt: Math.floor(Date.now() / 1000),
      ...ask,
    });
    const kid = await calculateJwkThumbprint(cell.publicJwk);
    return new CompactSign(new TextEncoder().encode(JSON.stringify(request)))
      .setProtectedHeader({ alg: CELL_TOKEN_ALGORITHM, kid, typ: GITHUB_TOKEN_REQUEST_TYPE })
      .sign(cell.privateKey);
  }

  /** The cell's call: no session, no origin, the signed request in the body. */
  async function askForToken(signed: string, headers: HeadersInit = {}) {
    const response = await app.request('/api/github/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ request: signed }),
    });
    const answer = await answerOf('POST', '/api/github/tokens', response);
    return { ...answer, headers: response.headers };
  }

  const storedMints = () => db.select().from(schema.githubTokenMint);

  it('a cell gets a token for one repository, which GitHub lets read that repository alone', async () => {
    const answer = await askForToken(await signedBy(euCell));
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({
      token: 'ghs_narrowed_1',
      expiresAt: Date.parse('2099-01-01T00:00:00Z') / 1000,
      repositories: [{ id: 410, fullName: 'acme/catalog-portal' }],
      permissions: { contents: 'read', metadata: 'read' },
    });
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(mintBodies).toEqual([{ repository_ids: [410], permissions: { contents: 'read' } }]);

    // As GitHub answers it: the repository it was minted for, and not the installation's other.
    expect(await readRepository(answer.body.token, 410)).toBe(200);
    expect(await readRepository(answer.body.token, 411)).toBe(404);
    expect(await readRepository(answer.body.token, 520)).toBe(404);

    const [record, ...more] = await storedMints();
    expect(more).toEqual([]);
    expect(record).toMatchObject({
      organizationId: workspaceIds.acme,
      installationId: 41,
      purpose: 'factory-pull',
      repositoryIds: [410],
      permissions: { contents: 'read', metadata: 'read' },
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
    expect(JSON.stringify(record)).not.toContain('ghs_');
  });

  it('gives each purpose its own permissions, and records every mint', async () => {
    const save = await askForToken(await signedBy(euCell, { purpose: 'factory-save' }));
    expect(save.body.permissions).toEqual({ contents: 'write', metadata: 'read' });
    const review = await askForToken(
      await signedBy(euCell, { purpose: 'review-run', repositoryIds: [411, 410] }),
    );
    expect(review.body.permissions).toEqual({
      contents: 'read',
      pull_requests: 'write',
      metadata: 'read',
    });
    expect(review.body.repositories).toEqual([
      { id: 410, fullName: 'acme/catalog-portal' },
      { id: 411, fullName: 'acme/api' },
    ]);
    const us = await askForToken(
      await signedBy(usCell, {
        workspaceId: workspaceIds.sprocket,
        installationId: 52,
        repositoryIds: [520],
      }),
    );
    expect(us.status).toBe(201);
    expect(mintBodies).toEqual([
      { repository_ids: [410], permissions: { contents: 'write' } },
      { repository_ids: [410, 411], permissions: { contents: 'read', pull_requests: 'write' } },
      { repository_ids: [520], permissions: { contents: 'read' } },
    ]);
    expect((await storedMints()).map((row) => [row.purpose, row.organizationId])).toEqual([
      ['factory-save', workspaceIds.acme],
      ['review-run', workspaceIds.acme],
      ['factory-pull', workspaceIds.sprocket],
    ]);
  });

  it('is outside the origin check: its authority is the signature, wherever it comes from', async () => {
    const elsewhere = await askForToken(await signedBy(euCell), {
      origin: 'http://localhost:9999',
    });
    expect(elsewhere.status).toBe(201);
    const unsigned = await askForToken('not-signed', { origin: 'http://localhost:9999' });
    expect(unsigned).toMatchObject({ status: 401, body: { error: 'unsigned' } });
  });

  it("refuses what no cell signed: a stranger's key, or the cell token a browser holds", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stranger = cellPairOf();
    expect(await askForToken(await signedBy(stranger))).toMatchObject({
      status: 401,
      body: { error: 'unsigned' },
    });

    // Dana, signed in, holds a cell token for Acme; it mints nothing at GitHub.
    const dana = await signIn('dana.again@acme.test', 'Dana Ortiz');
    await makeWorkspace(dana.headers, { name: 'Acme Two', slug: 'acme-two', region: 'eu' });
    const minted = await app.request('/api/cell-token', {
      method: 'POST',
      headers: fromBrowser(dana.headers),
    });
    const { token } = (await minted.json()) as { token: string };
    expect(await askForToken(token, fromBrowser(dana.headers))).toMatchObject({
      status: 401,
      body: { error: 'unsigned' },
    });
    expect(mintBodies).toEqual([]);
    expect(await storedMints()).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      "A request for a GitHub token carried no cell's signature.",
    );
  });

  it("never gives one workspace's cell a token for another workspace's installation", async () => {
    // Bolt's request, signed by the EU cell that serves both, names Acme's installation.
    expect(
      await askForToken(
        await signedBy(euCell, { workspaceId: workspaceIds.bolt, installationId: 41 }),
      ),
    ).toMatchObject({ status: 404, body: { error: 'installation_not_found' } });
    // Acme's request names Bolt's installation and repository.
    expect(
      await askForToken(await signedBy(euCell, { installationId: 42, repositoryIds: [420] })),
    ).toMatchObject({ status: 404, body: { error: 'installation_not_found' } });
    // The US cell asks for Acme, which is in the EU.
    expect(await askForToken(await signedBy(usCell))).toMatchObject({
      status: 403,
      body: { error: 'other_region' },
    });
    expect(mintBodies).toEqual([]);
    expect(await storedMints()).toEqual([]);
  });

  it("refuses a repository outside the workspace's installation, before anything is minted", async () => {
    const answer = await askForToken(
      await signedBy(euCell, { purpose: 'review-run', repositoryIds: [410, 520] }),
    );
    expect(answer).toMatchObject({
      status: 403,
      body: { error: 'repository_not_covered', repositoryIds: [520] },
    });
    expect(mintBodies).toEqual([]);
    expect(await storedMints()).toEqual([]);
  });

  it('refuses a request the contract does not read, or one its purpose does not allow', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const expired = await signedBy(euCell, {
      issuedAt: Math.floor(Date.now() / 1000) - GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS - 120,
    });
    expect(await askForToken(expired)).toMatchObject({
      status: 400,
      body: { error: 'unreadable' },
    });
    expect(logged).toHaveBeenCalledWith(
      "A cell's request for a GitHub token was refused: the request has expired.",
    );
    expect(
      await askForToken(
        await signedBy(euCell, { purpose: 'factory-save', repositoryIds: [410, 411] }),
      ),
    ).toMatchObject({
      status: 400,
      body: { error: 'invalid_token_request', problems: ['too-many-repositories'] },
    });
    expect(await askForToken(await signedBy(euCell, { repositoryIds: [] }))).toMatchObject({
      status: 400,
      body: { error: 'invalid_token_request', problems: ['no-repositories'] },
    });

    const noRequest = await app.request('/api/github/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'x' }),
    });
    expect(await answerOf('POST', '/api/github/tokens', noRequest)).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
    const notJson = await app.request('/api/github/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/jose' },
      body: await signedBy(euCell),
    });
    expect(await answerOf('POST', '/api/github/tokens', notJson)).toEqual({
      status: 415,
      body: { error: 'unsupported_media_type' },
    });
    expect(mintBodies).toEqual([]);
  });

  it('passes on what GitHub says of the installation and the scope', async () => {
    mintAnswer = () => Response.json(RECORDED.notAccessible, { status: 422 });
    expect(await askForToken(await signedBy(euCell))).toMatchObject({
      status: 403,
      body: { error: 'scope_refused' },
    });
    mintAnswer = () => Response.json({ message: 'Not Found' }, { status: 404 });
    expect(await askForToken(await signedBy(euCell))).toMatchObject({
      status: 410,
      body: { error: 'installation_gone' },
    });
    expect(await storedMints()).toEqual([]);
  });

  it('revokes a token GitHub did not narrow as asked, and hands out nothing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mintAnswer = () =>
      Response.json(
        {
          token: 'ghs_whole_installation',
          expires_at: '2099-01-01T00:00:00Z',
          permissions: { contents: 'read', metadata: 'read' },
          repository_selection: 'all',
        },
        { status: 201 },
      );
    expect(await askForToken(await signedBy(euCell))).toMatchObject({
      status: 503,
      body: { error: 'github_unavailable' },
    });
    expect(revoked).toEqual(['ghs_whole_installation']);
    expect(await storedMints()).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      'GitHub minted a token other than the one asked; it was revoked.',
    );
  });

  it('mints nothing when this server has no GitHub App', async () => {
    ({ app } = await composeApi({ db, config }, [testUtils()]));
    expect(await askForToken(await signedBy(euCell))).toMatchObject({
      status: 503,
      body: { error: 'github_not_configured' },
    });
  });

  it('never logs a token, a request or a key', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const good = await signedBy(euCell);
    await askForToken(good);
    await askForToken(await signedBy(cellPairOf()));
    await askForToken(
      await signedBy(euCell, {
        issuedAt: Math.floor(Date.now() / 1000) - GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS - 120,
      }),
    );
    mintAnswer = () =>
      Response.json({ token: 'ghs_wide', expires_at: '2099-01-01T00:00:00Z' }, { status: 201 });
    await askForToken(await signedBy(euCell));

    const logged = logs
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((arg) => inspect(arg, { depth: 10 })).join(' '))
      .join('\n');
    expect(logged).not.toBe('');
    for (const secret of [
      'ghs_',
      good,
      good.split('.')[2] ?? '',
      euCell.privateKey.export({ format: 'jwk' }).d as string,
      appKey.export({ type: 'pkcs1', format: 'pem' }).toString().split('\n')[1] ?? '',
    ]) {
      expect(secret).not.toBe('');
      expect(logged).not.toContain(secret);
    }
  });
});

describe("GitHub's webhooks", () => {
  // A secret made up for these tests: the app's real one lives only in .env.
  const WEBHOOK_SECRET = 'sprocket-test-webhook-secret-0123456789abcdef';
  const DELIVERY_ID = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
  const withWebhooks: CloudConfig = { ...config, githubWebhookSecret: WEBHOOK_SECRET };

  /** A payload GitHub sent, as the bytes on disk (`webhookFixtures/`). */
  const fixture = (name: string) =>
    readFileSync(
      new URL(`./adapters/github/webhookFixtures/${name}.json`, import.meta.url),
      'utf8',
    );

  const signatureOf = (body: string, secret = WEBHOOK_SECRET) =>
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  type Delivery = {
    event?: string;
    deliveryId?: string;
    /** The signature header: GitHub's over the body unless given; null sends none. */
    signature?: string | null;
  };

  /**
   * GitHub delivering `body` to the webhook URL, as GitHub does: no Origin, no cookie, its event,
   * its delivery id and its signature over the body's bytes. The answer is checked against the
   * contract.
   */
  async function deliver(body: string, delivery: Delivery = {}) {
    const headers = new Headers({
      'content-type': 'application/json',
      'user-agent': 'GitHub-Hookshot/7c1f5a2',
      'x-github-hook-installation-target-type': 'integration',
    });
    if (delivery.event !== undefined) headers.set('x-github-event', delivery.event);
    headers.set('x-github-delivery', delivery.deliveryId ?? DELIVERY_ID);
    const signature = delivery.signature === undefined ? signatureOf(body) : delivery.signature;
    if (signature !== null) headers.set('x-hub-signature-256', signature);
    const response = await app.request('/api/github/webhooks', { method: 'POST', headers, body });
    return answerOf('POST', '/api/github/webhooks', response);
  }

  /** A fixture with its installation changed, as GitHub would send it for another one. */
  const through = (name: string, installationId: number) => {
    const payload = JSON.parse(fixture(name));
    return JSON.stringify({
      ...payload,
      installation: { ...payload.installation, id: installationId },
    });
  };

  type Passed = { url: string; type: string | null; body: string };

  /**
   * The cells, behind `fetch`: each records a delivery once, by workspace and delivery id, as a
   * cell does, answering 201 the first time and 200 after. `down` makes them refuse to connect.
   */
  function cells() {
    const passed: Passed[] = [];
    const recorded = new Set<string>();
    const state = { down: false };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (![ACME_CELL, SPROCKET_CELL].includes(url.origin)) {
        throw new Error(`The test made an unexpected request to ${request.url}`);
      }
      if (state.down) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        });
      }
      const body = await request.text();
      passed.push({ url: request.url, type: request.headers.get('content-type'), body });
      const event = await asACell(body);
      const key = `${event.workspaceId} ${event.deliveryId}`;
      const first = !recorded.has(key);
      recorded.add(key);
      return Response.json({ recorded: true }, { status: first ? 201 : 200 });
    });
    return { passed, state };
  }

  /** A passed-on event read the way a cell reads it: its signature against the published keys. */
  async function asACell(body: string): Promise<GitHubEventMessage> {
    const keys = (await (await app.request(CELL_TOKEN_KEYS_PATH)).json()) as JSONWebKeySet;
    const { payload, protectedHeader } = await compactVerify(body, createLocalJWKSet(keys), {
      algorithms: [CELL_TOKEN_ALGORITHM],
    });
    expect(protectedHeader).toEqual({
      alg: CELL_TOKEN_ALGORITHM,
      kid: keys.keys[0]?.kid,
      typ: GITHUB_EVENT_TYPE,
    });
    const read = readGitHubEventMessage(JSON.parse(new TextDecoder().decode(payload)));
    if (!read.ok) throw new Error(read.reason);
    return read.value;
  }

  function logged() {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    return () =>
      spies
        .flatMap((spy) => spy.mock.calls)
        .map((args) => args.map((arg) => inspect(arg, { depth: 10 })).join(' '))
        .join('\n');
  }

  let sprocket: { id: string };
  let acme: { id: string };

  beforeEach(async () => {
    ({ app, auth } = await composeApi({ db, config: withWebhooks }, [testUtils()]));
    test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
    // Sprocket (US) holds the `sprocket` organisation's installation, 41; Acme (EU) holds 52.
    const lee = await signIn('lee@sprocket.test', 'Lee Park');
    sprocket = await makeWorkspace(lee.headers, {
      name: 'Sprocket',
      slug: 'sprocket',
      region: 'us',
    });
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    acme = await makeWorkspace(dana.headers);
    await db.insert(schema.githubInstallation).values([
      {
        installationId: 41,
        organizationId: sprocket.id,
        accountId: 9001,
        accountLogin: 'sprocket',
        accountType: 'Organization',
        connectedBy: lee.user.id,
        connectedAt: new Date('2026-11-22T21:00:00Z'),
      },
      {
        installationId: 52,
        organizationId: acme.id,
        accountId: 9002,
        accountLogin: 'acme',
        accountType: 'Organization',
        connectedBy: dana.user.id,
        connectedAt: new Date('2026-11-22T21:00:00Z'),
      },
    ]);
  });

  it("passes a pull request opened on Sprocket's repository to Sprocket's cell, in the US", async () => {
    const { passed } = cells();
    const log = logged();
    const body = fixture('pull_request.opened');

    expect(await deliver(body, { event: 'pull_request' })).toEqual({
      status: 200,
      body: { result: 'delivered' },
    });

    expect(passed.map(({ url, type }) => ({ url, type }))).toEqual([
      {
        url: `${SPROCKET_CELL}${GITHUB_EVENT_DELIVERY_PATH}`,
        type: GITHUB_EVENT_DELIVERY_MEDIA_TYPE,
      },
    ]);
    expect(await asACell(passed[0]?.body ?? '')).toEqual({
      workspaceId: sprocket.id,
      region: 'us',
      deliveryId: DELIVERY_ID,
      event: 'pull_request',
      installationId: 41,
      payload: JSON.parse(body),
    });
    expect(log()).toContain(
      `Passed GitHub delivery ${DELIVERY_ID} (pull_request) on to workspace ${sprocket.id}'s cell (us).`,
    );
  });

  it("passes Acme's push to Acme's cell, in the EU, and nowhere else", async () => {
    const { passed } = cells();
    logged();
    expect((await deliver(fixture('push'), { event: 'push' })).body).toEqual({
      result: 'delivered',
    });
    expect(passed.map(({ url }) => url)).toEqual([`${ACME_CELL}${GITHUB_EVENT_DELIVERY_PATH}`]);
    expect(await asACell(passed[0]?.body ?? '')).toMatchObject({
      workspaceId: acme.id,
      region: 'eu',
      event: 'push',
      installationId: 52,
    });
  });

  it('refuses the same delivery a second time as a duplicate, and the cell records it once', async () => {
    const { passed } = cells();
    logged();
    const body = fixture('pull_request.opened');
    expect((await deliver(body, { event: 'pull_request' })).status).toBe(200);
    expect(await deliver(body, { event: 'pull_request' })).toEqual({
      status: 409,
      body: { error: 'duplicate_delivery' },
    });
    // The same event under a new delivery id is a new delivery.
    const again = await deliver(body, {
      event: 'pull_request',
      deliveryId: '8a2b6d10-cc78-11e3-81ab-4c9367dc0958',
    });
    expect(again.status).toBe(200);
    expect(passed).toHaveLength(3);
  });

  it.each<[string, () => Delivery & { body: string }]>([
    ['no signature', () => ({ body: fixture('pull_request.opened'), signature: null })],
    [
      'a signature made with another secret',
      () => ({
        body: fixture('pull_request.opened'),
        signature: signatureOf(
          fixture('pull_request.opened'),
          'acme-webhook-secret-0123456789abcdef',
        ),
      }),
    ],
    [
      'a body changed after GitHub signed it',
      () => ({
        body: through('pull_request.opened', 52),
        signature: signatureOf(fixture('pull_request.opened')),
      }),
    ],
    [
      "GitHub's old SHA-1 signature alone",
      () => ({
        body: fixture('pull_request.opened'),
        signature: `sha1=${createHmac('sha1', WEBHOOK_SECRET).update(fixture('pull_request.opened')).digest('hex')}`,
      }),
    ],
  ])('refuses a delivery with %s, and passes nothing on', async (_what, made) => {
    const { passed } = cells();
    const log = logged();
    const { body, signature } = made();
    expect(await deliver(body, { event: 'pull_request', signature })).toEqual({
      status: 401,
      body: { error: 'bad_signature' },
    });
    expect(passed).toEqual([]);
    expect(log()).toContain(
      "Refused a webhook delivery: it is not signed with the GitHub App's webhook secret.",
    );
    // An unchecked delivery's id is anyone's words, so it is not logged.
    expect(log()).not.toContain(DELIVERY_ID);
  });

  it('drops and logs an event through an installation no workspace holds', async () => {
    const { passed } = cells();
    const log = logged();
    expect(await deliver(through('pull_request.opened', 63), { event: 'pull_request' })).toEqual({
      status: 422,
      body: { error: 'unknown_installation' },
    });
    expect(passed).toEqual([]);
    expect(log()).toContain(
      `Dropped GitHub delivery ${DELIVERY_ID} (pull_request): no workspace holds installation 63.`,
    );
  });

  it('drops an installation once its workspace disconnects it', async () => {
    const { passed } = cells();
    logged();
    await db
      .delete(schema.githubInstallation)
      .where(eq(schema.githubInstallation.installationId, 41));
    expect((await deliver(fixture('pull_request.opened'), { event: 'pull_request' })).body).toEqual(
      {
        error: 'unknown_installation',
      },
    );
    expect(passed).toEqual([]);
  });

  it("answers GitHub's ping, and passes it to no cell", async () => {
    const { passed } = cells();
    logged();
    expect(await deliver(fixture('ping'), { event: 'ping' })).toEqual({
      status: 200,
      body: { result: 'pong' },
    });
    expect(passed).toEqual([]);
  });

  it('refuses a signed delivery whose headers or body are not what GitHub sends', async () => {
    cells();
    logged();
    expect(await deliver(fixture('pull_request.opened'))).toEqual({
      status: 400,
      body: { error: 'invalid_delivery' },
    });
    expect(await deliver('action=opened', { event: 'pull_request' })).toEqual({
      status: 400,
      body: { error: 'invalid_delivery' },
    });
  });

  it("answers 502 while the cell is down, and GitHub's Redeliver gets the event through", async () => {
    const { passed, state } = cells();
    const log = logged();
    const body = fixture('pull_request.opened');
    state.down = true;
    expect(await deliver(body, { event: 'pull_request' })).toEqual({
      status: 502,
      body: { error: 'cell_unavailable' },
    });
    expect(log()).toContain(
      `Could not pass GitHub delivery ${DELIVERY_ID} (pull_request) on to workspace ${sprocket.id}'s cell (us): no connection (ECONNREFUSED).`,
    );

    // GitHub's Redeliver sends the same delivery, with the same id, once the cell is back.
    state.down = false;
    expect((await deliver(body, { event: 'pull_request' })).body).toEqual({ result: 'delivered' });
    expect(passed).toHaveLength(1);
  });

  it('refuses a body over what GitHub sends before reading it', async () => {
    cells();
    logged();
    const body = `{"padding":"${'x'.repeat(GITHUB_PAYLOAD_MAX_BYTES)}"}`;
    expect(await deliver(body, { event: 'pull_request', signature: 'sha256=00' })).toEqual({
      status: 413,
      body: { error: 'too_large' },
    });
  });

  it('without a webhook secret, refuses every delivery', async () => {
    ({ app } = await composeApi({ db, config: { ...config, githubWebhookSecret: null } }));
    const { passed } = cells();
    logged();
    expect(await deliver(fixture('pull_request.opened'), { event: 'pull_request' })).toEqual({
      status: 503,
      body: { error: 'webhooks_not_configured' },
    });
    expect(passed).toEqual([]);
  });

  it('never logs the secret, a signature or what an event says', async () => {
    cells();
    const log = logged();
    const body = fixture('pull_request.opened');
    await deliver(body, { event: 'pull_request' });
    await deliver(body, { event: 'pull_request' });
    await deliver(through('pull_request.opened', 63), { event: 'pull_request' });
    await deliver(body, {
      event: 'pull_request',
      signature: signatureOf(body, 'acme-webhook-secret-0123456789abcdef'),
    });

    const lines = log();
    expect(lines).toContain('Passed GitHub delivery');
    for (const secret of [
      WEBHOOK_SECRET,
      signatureOf(body).slice(7),
      'Price the catalog',
      'Lyon',
    ]) {
      expect(lines).not.toContain(secret);
    }
  });
});

describe('routes', () => {
  it('are these, and no other', () => {
    // A route with middleware or a body schema is one entry per handler in its chain.
    expect([...new Set(app.routes.map((route) => `${route.method} ${route.path}`))]).toEqual([
      'ALL /api/auth/*',
      'POST /api/github/tokens',
      'POST /api/github/webhooks',
      'ALL /api/*',
      'GET /api/me',
      'PUT /api/me/workspace',
      'PUT /api/me/workspace/icon',
      'GET /api/me/workspace/members',
      'GET /api/workspaces',
      'POST /api/workspaces',
      'POST /api/cell-token',
      'GET /api/cell-token/keys',
      'GET /api/connections',
      'POST /api/connections/github/install',
      'GET /api/github/callback',
      'DELETE /api/connections/github/installations/:installationId',
      'GET /api/health',
    ]);
  });

  it("every one of Better Auth's organisation routes is closed", async () => {
    const login = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(login.headers);
    const paths = closedPaths(organization());
    // Among them the routes that would make, change, delete, switch or join a workspace.
    expect(paths).toEqual(
      expect.arrayContaining([
        '/organization/create',
        '/organization/update',
        '/organization/delete',
        '/organization/set-active',
        '/organization/list',
        '/organization/invite-member',
        '/organization/accept-invitation',
      ]),
    );

    for (const path of paths) {
      for (const method of ['GET', 'POST']) {
        const response = await app.request(`/api/auth${path}`, {
          method,
          headers: fromBrowser(login.headers),
          ...(method === 'POST'
            ? { body: JSON.stringify({ organizationId: workspace.id, data: { region: 'us' } }) }
            : {}),
        });
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(await storedWorkspaces()).toEqual([
      { id: workspace.id, name: 'Acme', slug: 'acme', region: 'eu' },
    ]);
  });
});

describe('regions', () => {
  it('a workspace is in the region it was made in, and no route moves it', async () => {
    const login = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(login.headers, { ...acme, region: 'us' });

    // Every route that takes a body, given a region: none of them moves the workspace.
    await send('POST', '/api/workspaces', { ...acme, region: 'eu' }, login.headers);
    await send(
      'PUT',
      '/api/me/workspace',
      { workspaceId: workspace.id, region: 'eu' },
      login.headers,
    );
    await send(
      'PUT',
      '/api/me/workspace/icon',
      { icon: 'emoji-rocket', region: 'eu', name: 'Moved', slug: 'moved' },
      login.headers,
    );
    await app.request('/api/auth/update-session', {
      method: 'POST',
      headers: fromBrowser(login.headers),
      body: JSON.stringify({ activeOrganizationId: 'elsewhere', region: 'eu' }),
    });

    expect(await storedWorkspaces()).toEqual([
      { id: workspace.id, name: 'Acme', slug: 'acme', region: 'us' },
    ]);
    expect((await get('/api/me', login.headers)).body.workspace).toEqual({
      ...workspace,
      icon: 'emoji-rocket',
    });
  });
});

describe('the organisation from before workspaces', () => {
  /** The deployment's one organisation, as the service before workspaces left it. */
  async function oldOrganisation() {
    const dana = await test.saveUser(
      test.createUser({ email: 'dana@sprocket.test', name: 'Dana Ortiz', emailVerified: true }),
    );
    const lee = await test.saveUser(
      test.createUser({ email: 'lee@sprocket.test', name: 'Lee Park', emailVerified: true }),
    );
    await db.insert(schema.organization).values({
      id: 'sprocket-org',
      name: 'Sprocket',
      slug: 'sprocket',
      region: 'eu',
      createdAt: new Date('2026-11-21'),
    });
    await db.insert(schema.member).values([
      {
        id: 'm-dana',
        organizationId: 'sprocket-org',
        userId: dana.id,
        role: 'owner',
        createdAt: new Date('2026-11-21T10:00:00Z'),
      },
      {
        id: 'm-lee',
        organizationId: 'sprocket-org',
        userId: lee.id,
        role: 'member',
        createdAt: new Date('2026-11-21T11:00:00Z'),
      },
    ]);
    return { dana, lee };
  }

  const sprocket = { id: 'sprocket-org', name: 'Sprocket', slug: 'sprocket', region: 'eu' };

  it('carries on as an ordinary workspace, with its members and their roles', async () => {
    const { dana, lee } = await oldOrganisation();
    const danaLogin = await test.login({ userId: dana.id });
    const leeLogin = await test.login({ userId: lee.id });

    expect((await get('/api/me', danaLogin.headers)).body.workspace).toEqual({
      ...sprocket,
      role: 'owner',
      icon: null,
      canManage: true,
    });
    expect((await get('/api/workspaces', leeLogin.headers)).body).toEqual({
      workspaces: [{ ...sprocket, role: 'member', icon: null, canManage: false }],
    });
    expect((await get('/api/me', leeLogin.headers)).body.workspace).toEqual({
      ...sprocket,
      role: 'member',
      icon: null,
      canManage: false,
    });
    expect(await storedWorkspaces()).toEqual([sprocket]);
  });

  it('keeps its slug, and nobody new joins it by signing in', async () => {
    await oldOrganisation();
    const sam = await signIn('sam@sprocket.test', 'Sam Reyes');

    expect(await get('/api/me', sam.headers)).toMatchObject({ body: { workspace: null } });
    expect((await get('/api/workspaces', sam.headers)).body).toEqual({ workspaces: [] });
    expect(
      await send(
        'POST',
        '/api/workspaces',
        { name: 'Sprocket', slug: 'sprocket', region: 'us' },
        sam.headers,
      ),
    ).toEqual({ status: 409, body: { error: 'slug_taken' } });
    expect(await db.select().from(schema.member)).toHaveLength(2);
  });

  it('a member who makes a workspace of their own is in both', async () => {
    const { lee } = await oldOrganisation();
    const login = await test.login({ userId: lee.id });
    const own = await makeWorkspace(login.headers, acme);

    expect((await get('/api/workspaces', login.headers)).body).toEqual({
      workspaces: [{ ...sprocket, role: 'member', icon: null, canManage: false }, own],
    });
  });
});

describe('Google sign-in', () => {
  it('starting Google sign-in points Google back at the web origin', async () => {
    const response = await startGoogleSignIn();
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    const google = new URL(url);
    expect(google.hostname).toBe('accounts.google.com');
    expect(google.searchParams.get('redirect_uri')).toBe(`${WEB_ORIGIN}/api/auth/callback/google`);
    expect(google.searchParams.get('prompt')).toBe('select_account');
  });

  it('an unverified Google email goes back to the web app with an error', async () => {
    const signIn = await beginGoogleSignIn();
    stubGoogleToken({
      sub: 'google-sam',
      email: 'sam@sprocket.test',
      email_verified: false,
      name: 'Sam Reyes',
    });

    const { status, location } = await returnFromGoogle(signIn);

    expect(status).toBe(302);
    expect(location?.origin).toBe(WEB_ORIGIN);
    expect(location?.pathname).toBe('/');
    expect(location?.searchParams.get('error')).toBe('email_not_verified');
    expect(location?.searchParams.get('error_description')).toBe(
      'A verified email address is required.',
    );
    expect(await db.select().from(schema.user)).toEqual([]);
  });

  it('a returning person whose email is no longer verified goes back with an error', async () => {
    const dana = { sub: 'google-dana', email: 'dana@sprocket.test', name: 'Dana Ortiz' };
    stubGoogleToken({ ...dana, email_verified: true });
    const first = await returnFromGoogle(await beginGoogleSignIn());
    expect(first.status).toBe(302);
    expect(first.location?.searchParams.get('error')).toBeNull();
    await db
      .update(schema.user)
      .set({ emailVerified: false })
      .where(eq(schema.user.email, dana.email));

    stubGoogleToken({ ...dana, email_verified: false });
    const again = await returnFromGoogle(await beginGoogleSignIn());

    expect(again.status).toBe(302);
    expect(again.location?.origin).toBe(WEB_ORIGIN);
    expect(again.location?.searchParams.get('error')).toBe('email_not_verified');
    expect(await db.select().from(schema.session)).toHaveLength(1);
  });

  it('replaying a finished Google sign-in goes back to the web app with an error', async () => {
    stubGoogleToken({
      sub: 'google-dana',
      email: 'dana@sprocket.test',
      email_verified: true,
      name: 'Dana Ortiz',
    });
    const signIn = await beginGoogleSignIn();
    expect((await returnFromGoogle(signIn)).location?.searchParams.get('error')).toBeNull();
    const logged = expectStateLogged();

    const { status, location } = await returnFromGoogle(signIn);

    expect(status).toBe(302);
    expect(location?.origin).toBe(WEB_ORIGIN);
    expect(location?.pathname).toBe('/');
    expect(location?.searchParams.get('error')).toBe('state_mismatch');
    logged();
  });

  it('an unknown sign-in state goes back to the web app with an error', async () => {
    stubGoogleToken({ sub: 'google-dana', email: 'dana@sprocket.test', email_verified: true });
    const logged = expectStateLogged();

    const { status, location } = await returnFromGoogle({ state: 'not-a-state', cookie: '' });

    expect(status).toBe(302);
    expect(location?.origin).toBe(WEB_ORIGIN);
    expect(location?.pathname).toBe('/');
    expect(location?.searchParams.get('error')).toBe('state_mismatch');
    expect(await db.select().from(schema.user)).toEqual([]);
    logged();
  });

  it("Better Auth's own error page sends people to the web app", async () => {
    const response = await app.request('/api/auth/error?error=state_mismatch');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${WEB_ORIGIN}/?error=state_mismatch`);
  });
});

describe('rate limiting', () => {
  it('is on, whatever NODE_ENV says', async () => {
    expect((await auth.$context).rateLimit.enabled).toBe(true);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await startGoogleSignIn()).status);
    }
    // Better Auth allows three sign-in attempts per address every ten seconds.
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

describe('the session cookie', () => {
  it('the session cookie is httpOnly and SameSite=Lax', async () => {
    const { attributes } = (await auth.$context).authCookies.sessionToken;
    expect(attributes).toMatchObject({ httpOnly: true, sameSite: 'lax' });
    expect(attributes.secure).toBeFalsy();
  });

  it('the session cookie is Secure when PUBLIC_URL is https', async () => {
    const overHttps = (
      await composeApi({
        db,
        config: { ...config, publicUrl: 'https://cloud.sprocket.test' },
      })
    ).auth;
    const { attributes } = (await overHttps.$context).authCookies.sessionToken;
    expect(attributes).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true });
  });
});

describe('health', () => {
  it('health answers ok', async () => {
    expect(await get('/api/health')).toEqual({ status: 200, body: { ok: true } });
  });

  it('health answers 503 when the database is closed', async () => {
    await closeDatabase();
    expect(await get('/api/health')).toEqual({ status: 503, body: { ok: false } });
  });
});
