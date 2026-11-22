import { type TestHelpers, testUtils } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAuth } from './adapters/auth/betterAuth.js';
import { type Database, migrateDatabase, openDatabase } from './adapters/persistence/database.js';
import { schema } from './adapters/persistence/schema.js';
import { composeApi, prepareOrganization } from './compose.js';
import type { CloudConfig } from './config.js';
import type { Organization } from './domain/organization.js';

const WEB_ORIGIN = 'http://localhost:5175';

const config: CloudConfig = {
  databaseUrl: 'pglite:memory',
  authSecret: 'sprocket-test-secret-that-is-long-enough-to-sign-with',
  publicUrl: WEB_ORIGIN,
  port: 3100,
  google: { clientId: 'sprocket-test-client-id', clientSecret: 'sprocket-test-client-secret' },
  organization: { name: 'Sprocket', slug: 'sprocket' },
};

let db: Database;
let closeDatabase: () => Promise<void>;
let organization: Organization;
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
  organization = await prepareOrganization(db, config);
  // Built the way main.ts builds it, with Better Auth's test helpers added.
  ({ app, auth } = composeApi({ db, config, organization }, [testUtils()]));
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

async function get(path: string, headers?: Headers, on = app) {
  const response = await on.request(path, { headers });
  return { status: response.status, body: await response.json() };
}

describe('the organisation', () => {
  it('GET /api/org is public', async () => {
    expect(await get('/api/org')).toEqual({
      status: 200,
      body: { name: 'Sprocket', slug: 'sprocket' },
    });
  });
});

describe('who is signed in', () => {
  it('GET /api/me is 401 signed out', async () => {
    expect(await get('/api/me')).toEqual({ status: 401, body: { error: 'signed_out' } });
  });

  it('the first person to sign in is the owner', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    expect(await get('/api/me', login.headers)).toEqual({
      status: 200,
      body: {
        user: { id: login.user.id, name: 'Dana Ortiz', email: 'dana@sprocket.test', image: null },
        organization: { id: organization.id, name: 'Sprocket', slug: 'sprocket', region: 'eu' },
        role: 'owner',
      },
    });
  });

  it('the next person is a member', async () => {
    await signIn('dana@sprocket.test', 'Dana Ortiz');
    const login = await signIn('lee@sprocket.test', 'Lee Park');
    const me = await get('/api/me', login.headers);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('lee@sprocket.test');
    expect(me.body.organization.slug).toBe('sprocket');
    expect(me.body.role).toBe('member');
  });

  it('a session gets the organisation as its active one', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    const session = await auth.api.getSession({ headers: login.headers });
    expect(session?.session.activeOrganizationId).toBe(organization.id);
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
    expect(await db.select().from(schema.member)).toEqual([]);
  });

  it('a signed-in person who is not a member gets 403', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    const renamed = await prepareOrganization(db, {
      ...config,
      organization: { name: 'Sprocket', slug: 'sprocket-2' },
    });
    // The same database and secret, so the same session, served for another organisation.
    const onRenamed = composeApi({ db, config, organization: renamed }).app;
    expect(await get('/api/me', login.headers, onRenamed)).toEqual({
      status: 403,
      body: { error: 'not_a_member' },
    });
  });

  it('people cannot create organisations', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    const response = await app.request('/api/auth/organization/create', {
      method: 'POST',
      headers: fromBrowser(login.headers),
      body: JSON.stringify({ name: 'Elsewhere', slug: 'elsewhere' }),
    });
    expect(response.status).toBe(403);
    expect(await db.select().from(schema.organization)).toHaveLength(1);
  });

  it("the owner cannot change the organisation's region", async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    expect((await get('/api/me', login.headers)).body.role).toBe('owner');
    const update = (data: Record<string, unknown>) =>
      app.request('/api/auth/organization/update', {
        method: 'POST',
        headers: fromBrowser(login.headers),
        body: JSON.stringify({ organizationId: organization.id, data }),
      });

    // Better Auth drops the region from what it accepts, so this is an empty update, which it
    // answers with a 500 whatever the field. Only what is stored matters here.
    await update({ region: 'us' });
    // With a name beside it, the route runs and takes the name: it is the region alone it drops.
    const withName = await update({ name: 'Sprocket Labs', region: 'us' });
    expect(withName.status).toBe(200);
    expect(await withName.json()).toMatchObject({ name: 'Sprocket Labs', region: 'eu' });

    expect(await db.select().from(schema.organization)).toEqual([
      expect.objectContaining({ id: organization.id, name: 'Sprocket Labs', region: 'eu' }),
    ]);
    expect((await get('/api/me', login.headers)).body.organization.region).toBe('eu');
  });

  it('the owner cannot delete the organisation', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    expect((await get('/api/me', login.headers)).body.role).toBe('owner');
    const response = await app.request('/api/auth/organization/delete', {
      method: 'POST',
      headers: fromBrowser(login.headers),
      body: JSON.stringify({ organizationId: organization.id }),
    });
    expect(response.status).toBe(404);
    expect(await db.select().from(schema.organization)).toEqual([
      expect.objectContaining({ id: organization.id }),
    ]);
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
    expect(await db.select().from(schema.member)).toHaveLength(1);
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
      organization,
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
