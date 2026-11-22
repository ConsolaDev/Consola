import { organization, type TestHelpers, testUtils } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CloudAuth, closedPaths } from './adapters/auth/betterAuth.js';
import { type Database, migrateDatabase, openDatabase } from './adapters/persistence/database.js';
import { schema } from './adapters/persistence/schema.js';
import { composeApi } from './compose.js';
import type { CloudConfig } from './config.js';

const WEB_ORIGIN = 'http://localhost:5175';

const config: CloudConfig = {
  databaseUrl: 'pglite:memory',
  authSecret: 'sprocket-test-secret-that-is-long-enough-to-sign-with',
  publicUrl: WEB_ORIGIN,
  port: 3100,
  google: { clientId: 'sprocket-test-client-id', clientSecret: 'sprocket-test-client-secret' },
};

let db: Database;
let closeDatabase: () => Promise<void>;
let auth: CloudAuth;
let test: TestHelpers;
let app: Hono;
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
  ({ app, auth } = composeApi({ db, config }, [testUtils()]));
  // The plugin is passed in at runtime, so the type of `$context` does not know about it.
  test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
});

afterEach(async () => {
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

describe('routes', () => {
  it('are these, and no other', () => {
    expect(app.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'ALL /api/auth/*',
      'ALL /api/*',
      'GET /api/me',
      'PUT /api/me/workspace',
      'GET /api/workspaces',
      'POST /api/workspaces',
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
    const overHttps = composeApi({
      db,
      config: { ...config, publicUrl: 'https://cloud.sprocket.test' },
    }).auth;
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
