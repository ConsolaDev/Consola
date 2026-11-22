import { generateKeyPairSync } from 'node:crypto';
import { inspect } from 'node:util';
import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_AUDIENCE,
  CELL_TOKEN_KEYS_PATH,
  CELL_TOKEN_LIFETIME_SECONDS,
  CLOCK_SKEW_SECONDS,
  OUTBOX_DELIVERY_MEDIA_TYPE,
  OUTBOX_DELIVERY_PATH,
  OUTBOX_MESSAGE_TYPE,
  readCellTokenClaims,
  readOutboxMessage,
} from '@consola/cloud-contract';
import { organization, type TestHelpers, testUtils } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import {
  calculateJwkThumbprint,
  compactVerify,
  createLocalJWKSet,
  type JSONWebKeySet,
  jwtVerify,
} from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CloudAuth, closedPaths } from './adapters/auth/betterAuth.js';
import type { OutboxWorker } from './adapters/outbox/outboxWorker.js';
import { type Database, migrateDatabase, openDatabase } from './adapters/persistence/database.js';
import { schema } from './adapters/persistence/schema.js';
import { composeApi } from './compose.js';
import { type CloudConfig, ConfigError, type Ed25519PrivateJwk } from './config.js';

const WEB_ORIGIN = 'http://localhost:5175';
const ACME_CELL = 'http://127.0.0.1:3101';
const SPROCKET_CELL = 'http://127.0.0.1:3102';

// A key made for this run only, never one written down.
const cellKey = generateKeyPairSync('ed25519').privateKey.export({
  format: 'jwk',
}) as Ed25519PrivateJwk;

const config: CloudConfig = {
  databaseUrl: 'pglite:memory',
  authSecret: 'sprocket-test-secret-that-is-long-enough-to-sign-with',
  publicUrl: WEB_ORIGIN,
  port: 3100,
  google: { clientId: 'sprocket-test-client-id', clientSecret: 'sprocket-test-client-secret' },
  cellTokenPrivateKey: cellKey,
  // A cell in each region, which no test reaches unless it starts the outbox's worker.
  cellUrls: { eu: ACME_CELL, us: SPROCKET_CELL },
};

let db: Database;
let closeDatabase: () => Promise<void>;
let auth: CloudAuth;
let test: TestHelpers;
let app: Hono;
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

async function get(path: string, headers?: Headers) {
  const response = await app.request(path, { headers });
  return { status: response.status, body: await response.json() };
}

/** A change the web app sends: a JSON body, from the web origin, as `headers`' session. */
async function send(method: 'POST' | 'PUT', path: string, body: unknown, headers?: Headers) {
  const response = await app.request(path, {
    method,
    headers: fromBrowser(headers),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
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
      body: { id: expect.any(String), name: 'Acme', slug: 'acme', region: 'us', role: 'owner' },
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
    for (const body of ['not json', '[]', 'null']) {
      expect(await send('POST', '/api/workspaces', body, login.headers)).toMatchObject({
        status: 400,
        body: { error: 'invalid_workspace' },
      });
    }
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
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      body: await response.json(),
    };
  }

  /** The published key set, fetched as a cell fetches it: with no sign-in. */
  async function publishedKeys(): Promise<JSONWebKeySet> {
    const response = await app.request(CELL_TOKEN_KEYS_PATH);
    expect(response.status).toBe(200);
    return response.json();
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
      body: { token: expect.any(String), expiresAt: expect.any(Number) },
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

describe('routes', () => {
  it('are these, and no other', () => {
    expect(app.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'ALL /api/auth/*',
      'ALL /api/*',
      'GET /api/me',
      'PUT /api/me/workspace',
      'GET /api/workspaces',
      'POST /api/workspaces',
      'POST /api/cell-token',
      'GET /api/cell-token/keys',
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
    await app.request('/api/auth/update-session', {
      method: 'POST',
      headers: fromBrowser(login.headers),
      body: JSON.stringify({ activeOrganizationId: 'elsewhere', region: 'eu' }),
    });

    expect(await storedWorkspaces()).toEqual([
      { id: workspace.id, name: 'Acme', slug: 'acme', region: 'us' },
    ]);
    expect((await get('/api/me', login.headers)).body.workspace).toEqual(workspace);
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
    });
    expect((await get('/api/workspaces', leeLogin.headers)).body).toEqual({
      workspaces: [{ ...sprocket, role: 'member' }],
    });
    expect((await get('/api/me', leeLogin.headers)).body.workspace).toEqual({
      ...sprocket,
      role: 'member',
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
      workspaces: [{ ...sprocket, role: 'member' }, own],
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
