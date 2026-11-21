import { type TestHelpers, testUtils } from 'better-auth/plugins';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { type CloudAuth, createAuth } from './auth/auth.js';
import type { CloudConfig } from './config.js';
import { type Database, migrateDatabase, openDatabase } from './db/database.js';
import { schema } from './db/schema.js';
import { ensureOrganization, type Organization } from './organization.js';

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
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const opened = openDatabase(config.databaseUrl);
  db = opened.db;
  let closed = false;
  closeDatabase = async () => {
    if (closed) return;
    closed = true;
    await opened.close();
  };
  await migrateDatabase(db);
  organization = await ensureOrganization(db, config.organization);
  auth = createAuth({ db, config, organizationId: organization.id }, [testUtils()]);
  // The plugin is passed in at runtime, so the type of `$context` does not know about it.
  test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
  app = createApp({ db, auth, organization });
});

afterEach(async () => {
  await closeDatabase();
});

async function signIn(email: string, name: string) {
  const user = await test.saveUser(test.createUser({ email, name }));
  return test.login({ userId: user.id });
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
        organization: { id: organization.id, name: 'Sprocket', slug: 'sprocket' },
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

  it('a signed-in person who is not a member gets 403', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    const renamed = await ensureOrganization(db, { name: 'Sprocket', slug: 'sprocket-2' });
    const onRenamed = createApp({ db, auth, organization: renamed });
    expect(await get('/api/me', login.headers, onRenamed)).toEqual({
      status: 403,
      body: { error: 'not_a_member' },
    });
  });

  it('people cannot create organisations', async () => {
    const login = await signIn('dana@sprocket.test', 'Dana Ortiz');
    const headers = new Headers(login.headers);
    headers.set('origin', WEB_ORIGIN);
    headers.set('content-type', 'application/json');
    const response = await app.request('/api/auth/organization/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Elsewhere', slug: 'elsewhere' }),
    });
    expect(response.status).toBe(403);
    expect(await db.select().from(schema.organization)).toHaveLength(1);
  });
});

describe('Google sign-in', () => {
  it('starting Google sign-in points Google back at the web origin', async () => {
    const response = await app.request('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { origin: WEB_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/', errorCallbackURL: '/' }),
    });
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    const google = new URL(url);
    expect(google.hostname).toBe('accounts.google.com');
    expect(google.searchParams.get('redirect_uri')).toBe(`${WEB_ORIGIN}/api/auth/callback/google`);
    expect(google.searchParams.get('prompt')).toBe('select_account');
  });
});

describe('the session cookie', () => {
  it('the session cookie is httpOnly and SameSite=Lax', async () => {
    const { attributes } = (await auth.$context).authCookies.sessionToken;
    expect(attributes).toMatchObject({ httpOnly: true, sameSite: 'lax' });
    expect(attributes.secure).toBeFalsy();
  });

  it('the session cookie is Secure when PUBLIC_URL is https', async () => {
    const overHttps = createAuth({
      db,
      config: { ...config, publicUrl: 'https://cloud.sprocket.test' },
      organizationId: organization.id,
    });
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
