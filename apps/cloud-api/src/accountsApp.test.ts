import { inspect } from 'node:util';
import { organization } from 'better-auth/plugins';
import type { TestHelpers } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closedPaths } from './accounts/adapters/auth/betterAuth.js';
import { schema } from './accounts/adapters/persistence/schema.js';
import { WORKSPACE_HEADER } from './company/adapters/http/caller.js';
import { teamMembers, teams } from './company/adapters/persistence/tables.js';
import { ROUTES } from './compose.js';
import { workspaceOpening } from './persistence/database.js';
import { startApi } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

// Accounts' routes and the front door, on the app as `main.ts` composes it (`startApi`, through
// `composeApi`): signing in with Google (its token endpoint stubbed), who is signed in, their
// workspaces, a workspace's icon and members, and what stands in front of every route. GitHub's
// routes are `gitHubApp.test.ts`'s, and the company part's `companyApp.test.ts`'s.

let harness: Harness;
let test: TestHelpers;
let closed: boolean;
// Better Auth keeps rate-limit counts per client address and path, so each test signs in from
// an address of its own (TEST-NET-3, never routed).
let clients = 0;
let clientIp: string;

/** The app on a fresh database, with `environment` over the harness's stand-in configuration. */
async function start(environment?: Record<string, string>) {
  harness = await startApi({ environment });
  closed = false;
  // The plugin is passed in at runtime, so the type of `$context` does not know about it.
  test = ((await harness.auth.$context) as unknown as { test: TestHelpers }).test;
}

/** Closes the database once, whether a test closed it already or not. */
async function closeDatabase() {
  if (closed) return;
  closed = true;
  await harness.close();
}

/** The app again, on a new database, configured with `environment`. */
async function restart(environment: Record<string, string>) {
  await closeDatabase();
  await start(environment);
}

beforeEach(async () => {
  clients += 1;
  clientIp = `203.0.113.${clients}`;
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDatabase();
});

const webOrigin = () => harness.config.publicUrl;
const db = () => harness.db.accounts;

/** A person signed in: their id, and the headers their browser sends (the session cookie). */
async function signIn(email: string, name: string) {
  const person = await harness.signIn(email, name);
  return { personId: person.personId, headers: new Headers({ cookie: person.cookie }) };
}

/** Another session for a person who is signed in already, as signing in again makes. */
async function signInAgain(personId: string) {
  return (await test.login({ userId: personId })).headers;
}

/** A request the web app's proxy forwards: from the web origin, with the client's address. */
function fromBrowser(headers?: HeadersInit): Headers {
  const forwarded = new Headers(headers);
  forwarded.set('origin', webOrigin());
  forwarded.set('content-type', 'application/json');
  forwarded.set('x-forwarded-for', clientIp);
  return forwarded;
}

function startGoogleSignIn() {
  return harness.app.request('/api/auth/sign-in/social', {
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
    aud: harness.config.google.clientId,
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
  return idToken;
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
  const response = await harness.app.request(
    `/api/auth/callback/google?code=sprocket-code&state=${encodeURIComponent(signIn.state)}`,
    { headers: { cookie: signIn.cookie, 'x-forwarded-for': clientIp } },
  );
  const location = response.headers.get('location');
  return {
    status: response.status,
    location: location ? new URL(location, webOrigin()) : null,
    setCookies: response.headers.getSetCookie(),
  };
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

/** Every line logged from now on, as one text, with each argument printed in full. */
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

type ContractResponse = {
  content: { 'application/json': { schema: { safeParse(value: unknown): { error?: unknown } } } };
};

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
  // `any`: the tests read bodies by their fields.
  return { status: response.status, body: body as any };
}

async function get(path: string, headers?: Headers) {
  return answerOf('GET', path, await harness.app.request(path, { headers }));
}

/** A change the web app sends: a JSON body, from the web origin, as `headers`' session. */
async function send(method: 'POST' | 'PUT', path: string, body: unknown, headers?: Headers) {
  const response = await harness.app.request(path, {
    method,
    headers: fromBrowser(headers),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return answerOf(method, path, response);
}

const acme = { name: 'Acme', slug: 'acme' };

/** Makes a workspace as `headers`' session, failing the test unless it is made. */
async function makeWorkspace(headers: Headers, request: Record<string, unknown> = acme) {
  const made = await send('POST', '/api/workspaces', request, headers);
  expect(made.status).toBe(201);
  return made.body as { id: string; name: string; slug: string; region: string; role: string };
}

/** The workspace rows as stored, for checks that a route changed nothing. */
function storedWorkspaces() {
  return db()
    .select({
      id: schema.organization.id,
      name: schema.organization.name,
      slug: schema.organization.slug,
      region: schema.organization.region,
    })
    .from(schema.organization);
}

/** Puts `personId` in the workspace with `role`, straight into `member`, as no route does yet. */
async function addMember(workspaceId: string, personId: string, role: string) {
  await db()
    .insert(schema.member)
    .values({
      id: `m-${workspaceId}-${personId}`,
      organizationId: workspaceId,
      userId: personId,
      role,
      // A second after now, so the list's join order puts them after the owner.
      createdAt: new Date(Date.now() + 1000),
    });
}

describe('who is signed in', () => {
  it('GET /api/me is 401 signed out', async () => {
    expect(await get('/api/me')).toEqual({ status: 401, body: { error: 'signed_out' } });
  });

  it('someone who has made no workspace is signed in, in none', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    expect(await get('/api/me', dana.headers)).toEqual({
      status: 200,
      body: {
        user: { id: dana.personId, name: 'Dana Ortiz', email: 'dana@acme.test', image: null },
        workspace: null,
      },
    });
  });

  it('signing in joins no workspace', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    await makeWorkspace(dana.headers);
    await signIn('lee@sprocket.test', 'Lee Park');
    expect(await db().select().from(schema.member)).toEqual([
      expect.objectContaining({ userId: dana.personId, role: 'owner' }),
    ]);
  });

  it('a person no longer in their active workspace is in none', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    await makeWorkspace(dana.headers);
    await db().delete(schema.member).where(eq(schema.member.userId, dana.personId));
    expect((await get('/api/me', dana.headers)).body.workspace).toBeNull();
  });

  it('an unverified email cannot create an account', async () => {
    await expect(
      test.saveUser(test.createUser({ email: 'sam@sprocket.test', emailVerified: false })),
    ).rejects.toThrow('A verified email address is required.');
    expect(await db().select().from(schema.user)).toEqual([]);
  });

  it('a person whose email is no longer verified gets no session', async () => {
    const dana = await test.saveUser(
      test.createUser({ email: 'dana@sprocket.test', name: 'Dana Ortiz', emailVerified: true }),
    );
    await db().update(schema.user).set({ emailVerified: false }).where(eq(schema.user.id, dana.id));
    await expect(test.login({ userId: dana.id })).rejects.toThrow(
      'A verified email address is required.',
    );
    expect(await db().select().from(schema.session)).toEqual([]);
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

  it("a person makes a workspace, owns it and is in it, in the deployment's region", async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const made = await send('POST', '/api/workspaces', acme, dana.headers);
    expect(made).toEqual({
      status: 201,
      body: {
        id: expect.any(String),
        name: 'Acme',
        slug: 'acme',
        // No REGION: the deployment's default.
        region: 'eu',
        role: 'owner',
        icon: null,
        canManage: true,
      },
    });
    expect((await get('/api/me', dana.headers)).body.workspace).toEqual(made.body);
    expect(await get('/api/workspaces', dana.headers)).toEqual({
      status: 200,
      body: { workspaces: [made.body] },
    });
  });

  it('every new workspace is made in REGION, whatever the request names', async () => {
    await restart({ REGION: 'us' });
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const made = await makeWorkspace(dana.headers, { ...acme, region: 'eu' });
    expect(made.region).toBe('us');
    expect(await storedWorkspaces()).toEqual([
      { id: made.id, name: 'Acme', slug: 'acme', region: 'us' },
    ]);
  });

  it('two people each make a workspace and see only their own', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const lee = await signIn('lee@sprocket.test', 'Lee Park');
    const danas = await makeWorkspace(dana.headers, acme);
    const lees = await makeWorkspace(lee.headers, { name: 'Sprocket', slug: 'sprocket' });

    expect((await get('/api/workspaces', dana.headers)).body).toEqual({ workspaces: [danas] });
    expect((await get('/api/workspaces', lee.headers)).body).toEqual({ workspaces: [lees] });
    expect((await get('/api/me', dana.headers)).body.workspace).toEqual(danas);
    expect((await get('/api/me', lee.headers)).body.workspace).toEqual(lees);
  });

  it('a slug that is taken is refused', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const lee = await signIn('lee@sprocket.test', 'Lee Park');
    await makeWorkspace(dana.headers, acme);

    expect(await send('POST', '/api/workspaces', acme, lee.headers)).toEqual({
      status: 409,
      body: { error: 'slug_taken' },
    });
    expect(await send('POST', '/api/workspaces', acme, dana.headers)).toEqual({
      status: 409,
      body: { error: 'slug_taken' },
    });
    expect(await storedWorkspaces()).toEqual([expect.objectContaining({ slug: 'acme' })]);
    expect((await get('/api/workspaces', lee.headers)).body).toEqual({ workspaces: [] });
    expect((await get('/api/me', lee.headers)).body.workspace).toBeNull();
  });

  it('a workspace the rules refuse is 400, naming every problem', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    expect(
      await send('POST', '/api/workspaces', { name: ' ', slug: 'Acme' }, dana.headers),
    ).toEqual({
      status: 400,
      body: { error: 'invalid_workspace', problems: ['name_missing', 'slug_invalid'] },
    });
    expect(
      await send('POST', '/api/workspaces', { name: 'A'.repeat(200), slug: 'acme' }, dana.headers),
    ).toEqual({ status: 400, body: { error: 'invalid_workspace', problems: ['name_too_long'] } });
    // JSON of the wrong shape is a workspace with every problem; a body that is not JSON at all
    // is refused before the rules see it, as on every route.
    for (const body of ['[]', 'null', '{}', { name: 7, slug: ['acme'] }]) {
      expect(await send('POST', '/api/workspaces', body, dana.headers)).toEqual({
        status: 400,
        body: { error: 'invalid_workspace', problems: ['name_missing', 'slug_invalid'] },
      });
    }
    expect(await send('POST', '/api/workspaces', 'not json', dana.headers)).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
    expect(await storedWorkspaces()).toEqual([]);
  });

  it('a person switches between their workspaces', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const first = await makeWorkspace(dana.headers, acme);
    const second = await makeWorkspace(dana.headers, { ...acme, slug: 'acme-labs' });
    expect((await get('/api/me', dana.headers)).body.workspace).toEqual(second);

    expect(await send('PUT', '/api/me/workspace', { workspaceId: first.id }, dana.headers)).toEqual(
      { status: 200, body: first },
    );
    expect((await get('/api/me', dana.headers)).body.workspace).toEqual(first);
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
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    for (const body of [{}, { workspaceId: 7 }, 'not json']) {
      expect(await send('PUT', '/api/me/workspace', body, dana.headers)).toEqual({
        status: 400,
        body: { error: 'invalid_request' },
      });
    }
  });

  it('a body must be sent as JSON', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    for (const contentType of ['text/plain;charset=UTF-8', null]) {
      const headers = fromBrowser(dana.headers);
      if (contentType === null) headers.delete('content-type');
      else headers.set('content-type', contentType);
      const response = await harness.app.request('/api/workspaces', {
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
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const acmeWorkspace = await makeWorkspace(dana.headers, acme);
    await makeWorkspace(dana.headers, { ...acme, slug: 'acme-labs' });
    await send('PUT', '/api/me/workspace', { workspaceId: acmeWorkspace.id }, dana.headers);

    const again = await signInAgain(dana.personId);
    expect((await get('/api/me', again)).body.workspace).toEqual(acmeWorkspace);
  });

  it('a change from anywhere but the web app is refused', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    for (const origin of ['http://localhost:3000', 'null', null]) {
      const headers = fromBrowser(dana.headers);
      if (origin === null) headers.delete('origin');
      else headers.set('origin', origin);
      const response = await harness.app.request('/api/workspaces', {
        method: 'POST',
        headers,
        body: JSON.stringify(acme),
      });
      expect(await answerOf('POST', '/api/workspaces', response)).toEqual({
        status: 403,
        body: { error: 'bad_origin' },
      });
    }
    expect(await storedWorkspaces()).toEqual([]);
  });
});

describe('a workspace is born whole', () => {
  it('POST /api/workspaces writes the workspace, its owner, its first team and their place in it', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const made = await makeWorkspace(dana.headers);

    expect(await storedWorkspaces()).toEqual([
      { id: made.id, name: 'Acme', slug: 'acme', region: 'eu' },
    ]);
    expect(await db().select().from(schema.member)).toEqual([
      expect.objectContaining({ organizationId: made.id, userId: dana.personId, role: 'owner' }),
    ]);
    // As the owner's page reads it: the first team, with the owner in it.
    const page = new Headers(dana.headers);
    page.set(WORKSPACE_HEADER, made.id);
    const teamsRead = await harness.app.request('/api/teams', { headers: page });
    expect(teamsRead.status).toBe(200);
    expect(await teamsRead.json()).toEqual({
      canManage: true,
      teams: [{ id: expect.any(String), name: 'General', first: true, memberIds: [dana.personId] }],
    });
    // And as stored: one team, one place, both of this workspace.
    const [team, ...otherTeams] = await harness.db.company.select().from(teams);
    expect(otherTeams).toEqual([]);
    expect(team).toMatchObject({ workspaceId: made.id, isFirst: true });
    expect(await harness.db.company.select().from(teamMembers)).toEqual([
      expect.objectContaining({
        workspaceId: made.id,
        teamId: team?.teamId,
        personId: dana.personId,
      }),
    ]);
  });

  it('a workspace whose opening fails leaves no row behind: no workspace, member or team', async () => {
    const log = logged();
    // The company part's opening, run as the composition runs it, and then failing: what it
    // wrote must go with the rest.
    const opening = workspaceOpening.onCreated;
    if (!opening) throw new Error('The composition opens no workspace.');
    vi.spyOn(workspaceOpening as Required<typeof workspaceOpening>, 'onCreated').mockImplementation(
      async (tx, opened) => {
        await opening(tx, opened);
        throw new Error('The company part could not open the workspace.');
      },
    );
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');

    const response = await harness.app.request('/api/workspaces', {
      method: 'POST',
      headers: fromBrowser(dana.headers),
      body: JSON.stringify(acme),
    });

    expect(response.status).toBe(500);
    expect(log()).toContain('The company part could not open the workspace.');
    expect(await storedWorkspaces()).toEqual([]);
    expect(await db().select().from(schema.member)).toEqual([]);
    expect(await harness.db.company.select().from(teams)).toEqual([]);
    expect(await harness.db.company.select().from(teamMembers)).toEqual([]);
    // The session names no workspace that is not there.
    expect((await get('/api/me', dana.headers)).body.workspace).toBeNull();

    // Once the opening works again, the same slug makes the workspace.
    vi.mocked(workspaceOpening.onCreated as NonNullable<typeof opening>).mockRestore();
    expect((await makeWorkspace(dana.headers)).slug).toBe('acme');
  });
});

describe('GET /api/me/workspace/members', () => {
  const path = '/api/me/workspace/members';

  it('is 401 signed out', async () => {
    expect(await get(path)).toEqual({ status: 401, body: { error: 'signed_out' } });
  });

  it('is 409 with no workspace open', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    expect(await get(path, dana.headers)).toEqual({
      status: 409,
      body: { error: 'no_active_workspace' },
    });
  });

  it("lists the active workspace's members, with their ids and roles", async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(dana.headers);
    const lee = await signIn('lee@acme.test', 'Lee Park');
    await addMember(workspace.id, lee.personId, 'member');

    const answer = await get(path, dana.headers);
    expect(answer.status).toBe(200);
    expect(answer.body.members).toEqual([
      {
        id: dana.personId,
        name: 'Dana Ortiz',
        email: 'dana@acme.test',
        image: null,
        role: 'owner',
      },
      { id: lee.personId, name: 'Lee Park', email: 'lee@acme.test', image: null, role: 'member' },
    ]);
  });

  it('lists no one for a session whose workspace the person has left', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(dana.headers);
    await db().delete(schema.member).where(eq(schema.member.organizationId, workspace.id));
    expect(await get(path, dana.headers)).toEqual({
      status: 403,
      body: { error: 'not_a_member' },
    });
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
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    expect(await send('PUT', path, { icon: 'rocket' }, dana.headers)).toEqual({
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
    await addMember(workspace.id, lee.personId, 'member');
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
    await db().delete(schema.member).where(eq(schema.member.organizationId, workspace.id));
    expect(await send('PUT', path, { icon: 'moon' }, dana.headers)).toEqual({
      status: 403,
      body: { error: 'not_a_member' },
    });
  });

  it('reads a logo it did not write as no icon', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(dana.headers);
    await db()
      .update(schema.organization)
      .set({ logo: 'https://example.test/logo.png' })
      .where(eq(schema.organization.id, workspace.id));
    expect((await get('/api/me', dana.headers)).body.workspace.icon).toBeNull();
  });
});

describe('the front door', () => {
  it('answers 404 for a path no route serves, whoever asks', async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    for (const headers of [undefined, dana.headers]) {
      expect((await harness.app.request('/api/nowhere', { headers })).status).toBe(404);
    }
    const sent = await harness.app.request('/api/nowhere', {
      method: 'POST',
      headers: fromBrowser(dana.headers),
      body: '{}',
    });
    expect(sent.status).toBe(404);
  });

  it('refuses a change from another origin before it reaches any route, a missing one too', async () => {
    for (const origin of ['http://localhost:3000', 'https://sprocket.test', null]) {
      const headers = fromBrowser();
      if (origin === null) headers.delete('origin');
      else headers.set('origin', origin);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await harness.app.request('/api/nowhere', { method, headers });
        expect(response.status, `${method} from ${origin}`).toBe(403);
        expect(await response.json()).toEqual({ error: 'bad_origin' });
      }
    }
    // A read is no change, from anywhere.
    const read = await harness.app.request('/api/health', {
      headers: { origin: 'http://localhost:3000' },
    });
    expect(read.status).toBe(200);
  });

  it('refuses a cross-site change to a company route, though it carries a valid session', async () => {
    const owner = await harness.member('owner');
    for (const origin of ['http://localhost:3000', 'null', null]) {
      const headers = new Headers(owner.headers);
      if (origin === null) headers.delete('origin');
      else headers.set('origin', origin);
      for (const path of ['/api/teams', '/api/factories', '/api/cloud-sessions']) {
        const response = await harness.app.request(path, {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'Design' }),
        });
        expect(await answerOf('POST', path, response), `POST ${path} from ${origin}`).toEqual({
          status: 403,
          body: { error: 'bad_origin' },
        });
      }
    }
    // Nothing was made: the workspace still has its first team alone.
    const listed = await get('/api/teams', owner.headers);
    expect(listed.body.teams.map((team: { name: string }) => team.name)).toEqual(['General']);
    // From the web app, the same change goes through.
    const made = await harness.app.request('/api/teams', {
      method: 'POST',
      headers: owner.headers,
      body: JSON.stringify({ name: 'Design' }),
    });
    expect(made.status).toBe(201);
  });

  it("leaves every route under /api/auth/ to Better Auth's own origin check", async () => {
    // Better Auth's check is its own, and off while NODE_ENV is test (its default), so what it
    // does with these is not this suite's to see: only that Consola's never answers for it.
    for (const origin of ['http://localhost:3000', null]) {
      const headers = fromBrowser();
      if (origin === null) headers.delete('origin');
      else headers.set('origin', origin);
      const started = await harness.app.request('/api/auth/sign-in/social', {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider: 'google', callbackURL: '/', errorCallbackURL: '/' }),
      });
      expect(started.status, `from ${origin}`).toBe(200);
      expect(await started.json()).toMatchObject({ url: expect.any(String) });
    }
    // A path that only starts like it is no route of Better Auth's, and is guarded.
    const lookalike = fromBrowser();
    lookalike.set('origin', 'http://localhost:3000');
    const refused = await harness.app.request('/api/authority', {
      method: 'POST',
      headers: lookalike,
      body: '{}',
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'bad_origin' });
  });

  it('serves none of the routes that connected the two apps', async () => {
    for (const [method, path] of [
      ['POST', '/api/cell-token'],
      ['GET', '/api/cell-token/keys'],
      ['POST', '/api/github/tokens'],
      ['POST', '/api/github/events'],
      ['POST', '/api/outbox'],
    ] as const) {
      const response = await harness.app.request(path, {
        method,
        headers: fromBrowser(),
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('routes', () => {
  it('are these, and no other', () => {
    // A route with middleware or a body schema is one entry per handler in its chain.
    expect([
      ...new Set(harness.app.routes.map((route) => `${route.method} ${route.path}`)),
    ]).toEqual([
      'ALL /api/*',
      'ALL /api/auth/*',
      'GET /api/me',
      'PUT /api/me/workspace',
      'PUT /api/me/workspace/icon',
      'GET /api/me/workspace/members',
      'GET /api/workspaces',
      'POST /api/workspaces',
      'GET /api/teams',
      'POST /api/teams',
      'PATCH /api/teams/:teamId',
      'DELETE /api/teams/:teamId',
      'PUT /api/teams/:teamId/members/:personId',
      'DELETE /api/teams/:teamId/members/:personId',
      'GET /api/factories',
      'POST /api/factories',
      'GET /api/factories/:factoryId',
      'PATCH /api/factories/:factoryId',
      'GET /api/factories/:factoryId/versions/:version',
      'POST /api/factories/:factoryId/versions',
      'GET /api/factory-templates',
      'GET /api/runs',
      'POST /api/runs/:runId/approval',
      'GET /api/runs/:runId',
      'GET /api/cloud-sessions/options',
      'POST /api/cloud-sessions',
      'GET /api/cloud-sessions',
      'GET /api/cloud-sessions/:sessionId',
      'POST /api/cloud-sessions/:sessionId/stop',
      'POST /api/cloud-sessions/:sessionId/pass',
      'GET /api/connections',
      'POST /api/connections/github/install',
      'GET /api/github/callback',
      'GET /api/connections/github/choice',
      'POST /api/connections/github/choice',
      'DELETE /api/connections/github/installations/:installationId',
      'POST /api/github/webhooks',
      'GET /api/factories/:factoryId/slack',
      'PUT /api/factories/:factoryId/slack/credentials',
      'POST /api/factories/:factoryId/slack/install',
      'DELETE /api/factories/:factoryId/slack',
      'GET /api/slack/oauth/callback',
      'GET /api/slack/link-requests/:token',
      'POST /api/slack/link-requests/:token',
      'GET /api/slack/links',
      'DELETE /api/slack/links/:linkId',
      'POST /api/slack/events/:factoryId',
      'GET /api/health',
      'GET /api/runner',
    ]);
  });

  it("every one of Better Auth's organisation routes is closed", async () => {
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(dana.headers);
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
        const response = await harness.app.request(`/api/auth${path}`, {
          method,
          headers: fromBrowser(dana.headers),
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
    await restart({ REGION: 'us' });
    const dana = await signIn('dana@acme.test', 'Dana Ortiz');
    const workspace = await makeWorkspace(dana.headers, acme);
    expect(workspace.region).toBe('us');

    // Every route that takes a body, given a region: none of them moves the workspace.
    await send('POST', '/api/workspaces', { ...acme, region: 'eu' }, dana.headers);
    await send(
      'PUT',
      '/api/me/workspace',
      { workspaceId: workspace.id, region: 'eu' },
      dana.headers,
    );
    await send(
      'PUT',
      '/api/me/workspace/icon',
      { icon: 'emoji-rocket', region: 'eu', name: 'Moved', slug: 'moved' },
      dana.headers,
    );
    await harness.app.request('/api/auth/update-session', {
      method: 'POST',
      headers: fromBrowser(dana.headers),
      body: JSON.stringify({ activeOrganizationId: 'elsewhere', region: 'eu' }),
    });

    expect(await storedWorkspaces()).toEqual([
      { id: workspace.id, name: 'Acme', slug: 'acme', region: 'us' },
    ]);
    expect((await get('/api/me', dana.headers)).body.workspace).toEqual({
      ...workspace,
      icon: 'emoji-rocket',
    });
  });
});

// A workspace whose rows were written straight into the tables, as the one organisation from
// before workspaces was, and as a member is added until a route adds one (project 3).
describe('a workspace written straight into the tables', () => {
  async function writtenWorkspace() {
    const dana = await test.saveUser(
      test.createUser({ email: 'dana@sprocket.test', name: 'Dana Ortiz', emailVerified: true }),
    );
    const lee = await test.saveUser(
      test.createUser({ email: 'lee@sprocket.test', name: 'Lee Park', emailVerified: true }),
    );
    await db()
      .insert(schema.organization)
      .values({
        id: 'sprocket-org',
        name: 'Sprocket',
        slug: 'sprocket',
        region: 'eu',
        createdAt: new Date('2026-11-21'),
      });
    await db()
      .insert(schema.member)
      .values([
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

  it('is an ordinary workspace, with its members and their roles', async () => {
    const { dana, lee } = await writtenWorkspace();
    const danaSession = await signInAgain(dana.id);
    const leeSession = await signInAgain(lee.id);

    expect((await get('/api/me', danaSession)).body.workspace).toEqual({
      ...sprocket,
      role: 'owner',
      icon: null,
      canManage: true,
    });
    expect((await get('/api/workspaces', leeSession)).body).toEqual({
      workspaces: [{ ...sprocket, role: 'member', icon: null, canManage: false }],
    });
    expect((await get('/api/me', leeSession)).body.workspace).toEqual({
      ...sprocket,
      role: 'member',
      icon: null,
      canManage: false,
    });
    expect(await storedWorkspaces()).toEqual([sprocket]);
  });

  it('keeps its slug, and nobody new joins it by signing in', async () => {
    await writtenWorkspace();
    const sam = await signIn('sam@sprocket.test', 'Sam Reyes');

    expect(await get('/api/me', sam.headers)).toMatchObject({ body: { workspace: null } });
    expect((await get('/api/workspaces', sam.headers)).body).toEqual({ workspaces: [] });
    expect(
      await send('POST', '/api/workspaces', { name: 'Sprocket', slug: 'sprocket' }, sam.headers),
    ).toEqual({ status: 409, body: { error: 'slug_taken' } });
    expect(await db().select().from(schema.member)).toHaveLength(2);
  });

  it('a member who makes a workspace of their own is in both', async () => {
    const { lee } = await writtenWorkspace();
    const session = await signInAgain(lee.id);
    const own = await makeWorkspace(session, acme);

    expect((await get('/api/workspaces', session)).body).toEqual({
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
    expect(google.searchParams.get('redirect_uri')).toBe(`${webOrigin()}/api/auth/callback/google`);
    expect(google.searchParams.get('prompt')).toBe('select_account');
  });

  it('a verified Google email signs a new person in, in no workspace', async () => {
    stubGoogleToken({
      sub: 'google-dana',
      email: 'dana@sprocket.test',
      email_verified: true,
      name: 'Dana Ortiz',
    });
    const back = await returnFromGoogle(await beginGoogleSignIn());

    expect(back.status).toBe(302);
    expect(back.location?.origin).toBe(webOrigin());
    expect(back.location?.searchParams.get('error')).toBeNull();
    const cookie = back.setCookies.map((setCookie) => setCookie.split(';')[0]).join('; ');
    expect(await get('/api/me', new Headers({ cookie }))).toEqual({
      status: 200,
      body: {
        user: {
          id: expect.any(String),
          name: 'Dana Ortiz',
          email: 'dana@sprocket.test',
          image: null,
        },
        workspace: null,
      },
    });
    expect(await db().select().from(schema.member)).toEqual([]);
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
    expect(location?.origin).toBe(webOrigin());
    expect(location?.pathname).toBe('/');
    expect(location?.searchParams.get('error')).toBe('email_not_verified');
    expect(location?.searchParams.get('error_description')).toBe(
      'A verified email address is required.',
    );
    expect(await db().select().from(schema.user)).toEqual([]);
  });

  it('a returning person whose email is no longer verified goes back with an error', async () => {
    const dana = { sub: 'google-dana', email: 'dana@sprocket.test', name: 'Dana Ortiz' };
    stubGoogleToken({ ...dana, email_verified: true });
    const first = await returnFromGoogle(await beginGoogleSignIn());
    expect(first.status).toBe(302);
    expect(first.location?.searchParams.get('error')).toBeNull();
    await db()
      .update(schema.user)
      .set({ emailVerified: false })
      .where(eq(schema.user.email, dana.email));

    stubGoogleToken({ ...dana, email_verified: false });
    const again = await returnFromGoogle(await beginGoogleSignIn());

    expect(again.status).toBe(302);
    expect(again.location?.origin).toBe(webOrigin());
    expect(again.location?.searchParams.get('error')).toBe('email_not_verified');
    expect(await db().select().from(schema.session)).toHaveLength(1);
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
    const stateLogged = expectStateLogged();

    const { status, location } = await returnFromGoogle(signIn);

    expect(status).toBe(302);
    expect(location?.origin).toBe(webOrigin());
    expect(location?.pathname).toBe('/');
    expect(location?.searchParams.get('error')).toBe('state_mismatch');
    stateLogged();
  });

  it('an unknown sign-in state goes back to the web app with an error', async () => {
    stubGoogleToken({ sub: 'google-dana', email: 'dana@sprocket.test', email_verified: true });
    const stateLogged = expectStateLogged();

    const { status, location } = await returnFromGoogle({ state: 'not-a-state', cookie: '' });

    expect(status).toBe(302);
    expect(location?.origin).toBe(webOrigin());
    expect(location?.pathname).toBe('/');
    expect(location?.searchParams.get('error')).toBe('state_mismatch');
    expect(await db().select().from(schema.user)).toEqual([]);
    stateLogged();
  });

  it("Better Auth's own error page sends people to the web app", async () => {
    const response = await harness.app.request('/api/auth/error?error=state_mismatch');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${webOrigin()}/?error=state_mismatch`);
  });
});

describe('rate limiting', () => {
  it('is on, whatever NODE_ENV says', async () => {
    expect((await harness.auth.$context).rateLimit.enabled).toBe(true);
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
    const { attributes } = (await harness.auth.$context).authCookies.sessionToken;
    expect(attributes).toMatchObject({ httpOnly: true, sameSite: 'lax' });
    expect(attributes.secure).toBeFalsy();
  });

  it('the session cookie is Secure when PUBLIC_URL is https', async () => {
    await restart({ PUBLIC_URL: 'https://cloud.sprocket.test' });
    const { attributes } = (await harness.auth.$context).authCookies.sessionToken;
    expect(attributes).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true });
  });
});

describe('health', () => {
  it('health answers ok, with no session', async () => {
    expect(await get('/api/health')).toEqual({ status: 200, body: { ok: true } });
  });

  it('health answers 503 when the database is closed', async () => {
    await closeDatabase();
    expect(await get('/api/health')).toEqual({ status: 503, body: { ok: false } });
  });
});

describe('what is logged', () => {
  it('never holds a secret, a session or what Google answered', async () => {
    const log = logged();
    const idToken = stubGoogleToken({
      sub: 'google-dana',
      email: 'dana@sprocket.test',
      email_verified: true,
      name: 'Dana Ortiz',
    });
    const back = await returnFromGoogle(await beginGoogleSignIn());
    const session = new Headers({
      cookie: back.setCookies.map((setCookie) => setCookie.split(';')[0]).join('; '),
    });
    await returnFromGoogle({ state: 'not-a-state', cookie: '' });
    await makeWorkspace(session);
    await send('POST', '/api/workspaces', 'not json', session);
    await send('PUT', '/api/me/workspace/icon', { icon: 'unicorn' }, session);
    await get('/api/me/workspace/members', session);
    const elsewhere = fromBrowser(session);
    elsewhere.set('origin', 'http://localhost:3000');
    await harness.app.request('/api/workspaces', {
      method: 'POST',
      headers: elsewhere,
      body: '{}',
    });

    const lines = log();
    const sessionToken = (session.get('cookie') ?? '').split('=')[1] ?? '';
    for (const secret of [
      harness.config.authSecret,
      harness.config.google.clientSecret,
      'sprocket-access-token',
      idToken,
      sessionToken,
    ]) {
      expect(secret).not.toBe('');
      expect(lines).not.toContain(secret);
    }
  });
});
