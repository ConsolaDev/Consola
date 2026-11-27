import type { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';
import { whoIsAskingOf } from './accounts/adapters/auth/betterAuth.js';
import { ACCOUNT_ROUTES } from './accounts/adapters/http/app.js';
import { createMembershipReader } from './accounts/adapters/persistence/membershipReader.js';
import { schema as accounts } from './accounts/adapters/persistence/schema.js';
import { requireCaller, WORKSPACE_HEADER } from './company/adapters/http/caller.js';
import type { CompanyEnv } from './company/adapters/http/caller.js';
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
} from './company/adapters/http/contract.js';
import { GITHUB_WEBHOOK_PATH } from './company/adapters/http/gitHubContract.js';
import { teams } from './company/adapters/persistence/tables.js';
import { FIRST_TEAM_NAME } from './company/domain/team.js';
import type { ROUTES } from './compose.js';
import { getHealth } from './http/health.js';
import { WORKSPACE_ROLES } from './shared/workspaceRole.js';
import { startApi } from './testing/harness.js';
import type { Harness, Member } from './testing/harness.js';

// Company's routes on the composed app, as the web app's pages call them: each person is signed
// in through the harness (Better Auth's session cookie, no Google), and their page sends the
// workspace it shows (`x-consola-workspace`). Who they are and their role come from the session
// and `member`, read on every request.

let harness: Harness;

beforeEach(async () => {
  harness = await startApi();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.close();
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

type AskInit = {
  body?: unknown;
  /** Set on top of the person's page headers. */
  headers?: Record<string, string>;
  /** The app asked, when not the harness's own (one restarted with a runner, say). */
  app?: OpenAPIHono;
};

/** Asks `route` at `path` from `who`'s page, and reads its answer by the contract. */
async function ask(route: ContractRoute, path: string, who: Member, init: AskInit = {}) {
  const headers = new Headers(who.headers);
  for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);
  let body: string | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
  }
  const app = init.app ?? harness.app;
  const response = await app.request(path, { method: route.method.toUpperCase(), headers, body });
  return { status: response.status, body: await answerOf(route, response) };
}

/**
 * A request as the web app's page would send it, with no session: its origin (so a change passes
 * the origin check), JSON, and the workspace the page shows.
 */
function bare(workspaceId = 'acme'): Headers {
  return new Headers({
    origin: harness.config.publicUrl,
    'content-type': 'application/json',
    [WORKSPACE_HEADER]: workspaceId,
  });
}

/** The person's page with `changes` made to its headers (a value, or null to leave one out). */
function pageWith(who: Member, changes: Record<string, string | null>): Headers {
  const headers = new Headers(who.headers);
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return headers;
}

let elsewhere = 0;

/**
 * `who` makes a workspace of their own, as from another tab: their session opens it, so the page
 * they had (`who.headers`) now shows a workspace their session does not have open. Answers their
 * page for the new one.
 */
async function makesWorkspace(who: Member, name: string): Promise<Member> {
  elsewhere += 1;
  const response = await harness.app.request('/api/workspaces', {
    method: 'POST',
    headers: who.headers,
    body: JSON.stringify({ name, slug: `elsewhere-${elsewhere}` }),
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  return {
    personId: who.personId,
    workspaceId: id,
    headers: pageWith(who, { [WORKSPACE_HEADER]: id }),
  };
}

/** Opens one of the person's workspaces in their session, as the workspace switcher does. */
async function opens(who: Member, workspaceId: string): Promise<void> {
  const response = await harness.app.request('/api/me/workspace', {
    method: 'PUT',
    headers: who.headers,
    body: JSON.stringify({ workspaceId }),
  });
  expect(response.status).toBe(200);
}

describe('GET /api/health', () => {
  it('answers ok while the database answers', async () => {
    const response = await harness.app.request('/api/health');
    expect(response.status).toBe(200);
    expect(await answerOf(getHealth, response)).toEqual({ ok: true });
  });

  it('answers 503 once the database does not', async () => {
    await harness.close();
    const response = await harness.app.request('/api/health');
    expect(response.status).toBe(503);
    expect(await answerOf(getHealth, response)).toEqual({ ok: false });
  });

  it('needs no session, and ignores a cookie that is none', async () => {
    expect((await harness.app.request('/api/health')).status).toBe(200);
    const forged = { cookie: 'better-auth.session_token=forged.signature' };
    expect((await harness.app.request('/api/health', { headers: forged })).status).toBe(200);
    expect((await harness.app.request('/api/health', { method: 'HEAD' })).status).toBe(200);
  });
});

describe('a company request without a session', () => {
  it('is 401 signed_out, whatever workspace its page says it shows', async () => {
    const owner = await harness.member('owner');
    for (const headers of [new Headers(), bare(), bare(owner.workspaceId)]) {
      const response = await harness.app.request('/api/teams', { headers });
      expect(response.status).toBe(401);
      expect(await answerOf(listTeams, response)).toEqual({ error: 'signed_out' });
    }
  });

  it('is what a session anywhere but its cookie is', async () => {
    const owner = await harness.member('owner');
    const cookie = owner.headers.get('cookie') ?? '';
    const token = cookie.slice(cookie.indexOf('=') + 1);
    const basic = `Basic ${Buffer.from('acme:secret').toString('base64')}`;
    for (const [path, headers] of [
      [`/api/teams?session_token=${encodeURIComponent(token)}`, {}],
      ['/api/teams', { authorization: `Bearer ${token}` }],
      ['/api/teams', { 'x-session-token': token }],
      ['/api/teams', { authorization: basic }],
    ] as const) {
      const sent = bare(owner.workspaceId);
      for (const [name, value] of Object.entries(headers)) sent.set(name, value);
      const response = await harness.app.request(path, { headers: sent });
      expect([path, response.status]).toEqual([path, 401]);
      expect(await answerOf(listTeams, response)).toEqual({ error: 'signed_out' });
    }
  });
});

/** The cookie's name and its signed value, `<token>.<signature>`. */
function cookieParts(cookie: string) {
  const name = cookie.slice(0, cookie.indexOf('='));
  const value = cookie.slice(cookie.indexOf('=') + 1);
  const dot = value.indexOf('.');
  return { name, token: value.slice(0, dot), signature: value.slice(dot + 1) };
}

describe('a company request with a cookie that is no session', () => {
  it.each<[string, (owner: Member, cookie: string) => string | Promise<string>]>([
    ['an empty one', (_owner, cookie) => `${cookieParts(cookie).name}=`],
    ['a malformed one', (_owner, cookie) => `${cookieParts(cookie).name}=not-a-session`],
    [
      'a forged one: its token changed after signing',
      (_owner, cookie) => {
        const { name, token, signature } = cookieParts(cookie);
        const changed = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
        return `${name}=${changed}.${signature}`;
      },
    ],
    [
      'one with its signature taken off',
      (_owner, cookie) => `${cookieParts(cookie).name}=${cookieParts(cookie).token}`,
    ],
    [
      'one whose session has ended',
      async (owner, cookie) => {
        await harness.db.accounts
          .delete(accounts.session)
          .where(eq(accounts.session.userId, owner.personId));
        return cookie;
      },
    ],
  ])('is 401 signed_out for %s', async (_what, cookieOf) => {
    const owner = await harness.member('owner');
    const cookie = await cookieOf(owner, owner.headers.get('cookie') ?? '');
    for (const [route, path, body] of [
      [listTeams, '/api/teams', undefined],
      [postTeam, '/api/teams', JSON.stringify({ name: 'Platform' })],
    ] as const) {
      const response = await harness.app.request(path, {
        method: route.method.toUpperCase(),
        headers: pageWith(owner, { cookie }),
        body,
      });
      expect([path, response.status]).toEqual([path, 401]);
      expect(await answerOf(route, response)).toEqual({ error: 'signed_out' });
    }
    // Nothing was made with it.
    const made = await harness.db.company
      .select({ name: teams.name })
      .from(teams)
      .where(eq(teams.workspaceId, owner.workspaceId));
    expect(made).toEqual([{ name: FIRST_TEAM_NAME }]);
  });
});

describe('the caller check', () => {
  it('is 400 invalid_request for a page that does not say which workspace it shows', async () => {
    const owner = await harness.member('owner');
    for (const shown of [null, '', '   ']) {
      const response = await harness.app.request('/api/teams', {
        headers: pageWith(owner, { [WORKSPACE_HEADER]: shown }),
      });
      expect([shown, response.status]).toEqual([shown, 400]);
      expect(await answerOf(listTeams, response)).toEqual({ error: 'invalid_request' });
    }
  });

  it('is 409 no_active_workspace for a session with no workspace open', async () => {
    const owner = await harness.member('owner');
    const dana = await harness.signIn('dana@acme.test', 'Dana Ortiz');
    const response = await harness.app.request('/api/teams', {
      headers: pageWith(owner, { cookie: dana.cookie }),
    });
    expect(response.status).toBe(409);
    expect(await answerOf(listTeams, response)).toEqual({ error: 'no_active_workspace' });
  });

  it('is 403 not_a_member for a session open on a workspace the person was never in, writing nothing', async () => {
    const owner = await harness.member('owner');
    const dana = await harness.signIn('dana@acme.test', 'Dana Ortiz');
    // Dana's session open on Acme, which nothing Consola serves would let it be.
    await harness.db.accounts
      .update(accounts.session)
      .set({ activeOrganizationId: owner.workspaceId })
      .where(eq(accounts.session.userId, dana.personId));
    const page = pageWith(owner, { cookie: dana.cookie });

    const listed = await harness.app.request('/api/teams', { headers: page });
    expect(listed.status).toBe(403);
    expect(await answerOf(listTeams, listed)).toEqual({ error: 'not_a_member' });
    const made = await harness.app.request('/api/teams', {
      method: 'POST',
      headers: page,
      body: JSON.stringify({ name: 'Platform' }),
    });
    expect(made.status).toBe(403);
    expect(await answerOf(postTeam, made)).toEqual({ error: 'not_a_member' });
    expect((await teamsSeenBy(owner)).teams.map((team) => team.name)).toEqual([FIRST_TEAM_NAME]);
  });

  it('refuses in its order: signed out first, then a page that names no workspace', async () => {
    const dana = await harness.signIn('dana@acme.test', 'Dana Ortiz');
    const signedOut = await harness.app.request('/api/teams');
    expect(await answerOf(listTeams, signedOut)).toEqual({ error: 'signed_out' });
    // No workspace named and none open: the page's header is asked for first.
    const unnamed = await harness.app.request('/api/teams', { headers: { cookie: dana.cookie } });
    expect(unnamed.status).toBe(400);
    expect(await answerOf(listTeams, unnamed)).toEqual({ error: 'invalid_request' });
  });

  it('lets every role on, with what `member` says that role may do', async () => {
    const owner = await harness.member('owner');
    for (const role of WORKSPACE_ROLES) {
      const person =
        role === 'owner' ? owner : await harness.member(role, { workspace: owner.workspaceId });
      const answer = await ask(listTeams, '/api/teams', person);
      const { canManage } = answer.body as { canManage: boolean };
      expect([role, answer.status, canManage]).toEqual([role, 200, role !== 'member']);
    }
  });
});

/**
 * The routes that answer a request with no session, and what each answers a bare one: the health
 * check; GitHub's webhook deliveries, which are signed instead (with no webhook secret set, as
 * here, each is refused before it is read); GitHub's callback, a redirect that reads the session
 * itself and says in the redirect that there is none; and the runner's socket, behind the
 * runner's secret instead, which a bare request does not carry. Nothing else of company's is open.
 */
const OPEN_ROUTES: Record<string, number> = {
  'GET /api/health': 200,
  [`POST ${GITHUB_WEBHOOK_PATH}`]: 503,
  'GET /api/github/callback': 302,
  'GET /api/runner': 401,
};

/** The methods that change something, which the front door lets through only from the web app. */
const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Accounts' routes, as Hono lists them (`{param}` as `:param`): `accountsApp.test.ts`'s. */
const ACCOUNTS_ROUTES = new Set(
  ACCOUNT_ROUTES.map(
    (route) => `${route.method.toUpperCase()} ${route.path.replaceAll(/\{([^}]+)\}/g, ':$1')}`,
  ),
);

/**
 * Every route of company's the app holds (GitHub's, the health check and the runner's socket
 * included), each once, though Hono lists a route once per handler in its chain: all but
 * accounts' routes, Better Auth's (`/api/auth/*`) and the front door's origin check (`/api/*`).
 * So a new company route is here without being named.
 */
function companyRoutes(app: OpenAPIHono) {
  const listed = app.routes.filter(
    ({ method, path }) =>
      !(method === 'ALL' && (path === '/api/*' || path === '/api/auth/*')) &&
      !ACCOUNTS_ROUTES.has(`${method} ${path}`),
  );
  return [...new Map(listed.map((route) => [`${route.method} ${route.path}`, route])).values()];
}

/** A route's path with every parameter filled in. */
const filled = (path: string) => path.replaceAll(/:[^/]+/g, 'x');

describe('every route', () => {
  it('of company but the open ones refuses a request without a session', async () => {
    for (const level of ['error', 'warn', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    const routes = companyRoutes(harness.app);
    expect(routes.length).toBeGreaterThan(20);
    for (const { method, path } of routes) {
      const response = await harness.app.request(filled(path), { method, headers: bare() });
      const route = `${method} ${path}`;
      expect([route, response.status]).toEqual([route, OPEN_ROUTES[route] ?? 401]);
      if (!(route in OPEN_ROUTES)) {
        expect([route, await response.json()]).toEqual([route, { error: 'signed_out' }]);
      }
    }
    // Each open route is one the app has.
    const held = new Set(routes.map(({ method, path }) => `${method} ${path}`));
    expect(Object.keys(OPEN_ROUTES).filter((route) => !held.has(route))).toEqual([]);
  });

  it('of company that changes something refuses another site, before the session is asked', async () => {
    const owner = await harness.member('owner');
    const changes = companyRoutes(harness.app).filter(
      ({ method, path }) => CHANGES.has(method) && path !== GITHUB_WEBHOOK_PATH,
    );
    expect(changes.length).toBeGreaterThan(10);
    for (const origin of ['https://sprocket.example', 'http://localhost:5176', null]) {
      for (const { method, path } of changes) {
        const response = await harness.app.request(filled(path), {
          method,
          headers: pageWith(owner, { origin }),
          body: JSON.stringify({ name: 'Cross-site' }),
        });
        const route = `${method} ${path}`;
        expect([route, origin, response.status]).toEqual([route, origin, 403]);
        expect(await response.json()).toEqual({ error: 'bad_origin' });
      }
    }
    expect((await teamsSeenBy(owner)).teams.map((team) => team.name)).toEqual([FIRST_TEAM_NAME]);
  });

  it('that does not exist is 404, whoever asks', async () => {
    const owner = await harness.member('owner');
    for (const path of ['/', '/api/nowhere', '/api/workspaces/sprocket', '/api/teams/x/y']) {
      expect([path, (await harness.app.request(path)).status]).toEqual([path, 404]);
      const asked = await harness.app.request(path, { headers: owner.headers });
      expect([path, asked.status]).toEqual([path, 404]);
    }
  });

  it("opens GitHub's webhook path to deliveries alone: it has no other method", async () => {
    const owner = await harness.member('owner');
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const response = await harness.app.request(GITHUB_WEBHOOK_PATH, {
        method,
        headers: owner.headers,
      });
      expect([method, response.status]).toEqual([method, 404]);
    }
  });

  it('takes no workspace from its path', () => {
    const parameters = harness.app.routes.flatMap(({ path }) =>
      [...path.matchAll(/:([^/{]+)/g)].map((match) => match[1] ?? ''),
    );
    expect(parameters.length).toBeGreaterThan(5);
    expect(parameters.filter((name) => /workspace|^ws$/i.test(name))).toEqual([]);
  });
});

/**
 * A company table made for one test alone (none of the app's would do: each has a route of its
 * own), as every company table is: with its workspace's id.
 */
const note = pgTable('note', {
  workspaceId: text('workspace_id').notNull(),
  body: text('body').notNull(),
});

describe("a workspace's rows", () => {
  it('are read only for the workspace the session has open, whatever the request names', async () => {
    // A route added the way company's are, behind the caller check and scoped by its caller,
    // before any request is made, while Hono still takes routes.
    const caller = requireCaller({
      whoIsAsking: whoIsAskingOf(harness.auth),
      membership: createMembershipReader(harness.db.accounts),
    });
    const notes = new Hono<CompanyEnv>();
    notes.get('/', caller, async (c) => {
      const rows = await harness.db.company
        .select({ body: note.body })
        .from(note)
        .where(eq(note.workspaceId, c.var.caller.workspaceId));
      return c.json(rows.map((row) => row.body));
    });
    harness.app.route('/api/notes', notes);

    await harness.db.company.execute(
      sql`create table note (workspace_id text not null, body text not null)`,
    );
    const acme = await harness.member('owner');
    const sprocket = await harness.member('owner');
    await harness.db.company.insert(note).values([
      { workspaceId: acme.workspaceId, body: 'Acme plan' },
      { workspaceId: sprocket.workspaceId, body: 'Sprocket plan' },
    ]);

    // Sprocket named every way a request could name it, from Acme's page.
    for (const path of [
      '/api/notes',
      `/api/notes?workspaceId=${sprocket.workspaceId}`,
      `/api/notes?ws=${sprocket.workspaceId}`,
    ]) {
      const response = await harness.app.request(path, {
        headers: pageWith(acme, { 'x-workspace-id': sprocket.workspaceId }),
      });
      expect([path, await response.json()]).toEqual([path, ['Acme plan']]);
    }
    // Naming it where the page says what it shows is no way in: it is not what Acme's session has.
    const named = await harness.app.request('/api/notes', {
      headers: pageWith(acme, { [WORKSPACE_HEADER]: sprocket.workspaceId }),
    });
    expect(named.status).toBe(409);
    expect(await named.json()).toEqual({ error: 'workspace_switched' });
    const own = await harness.app.request('/api/notes', { headers: sprocket.headers });
    expect(await own.json()).toEqual(['Sprocket plan']);
    expect((await harness.app.request('/api/notes')).status).toBe(401);
  });
});

type TeamBody = { id: string; name: string; first: boolean; memberIds: string[] };

async function teamsSeenBy(who: Member) {
  const answer = await ask(listTeams, '/api/teams', who);
  expect(answer.status).toBe(200);
  return answer.body as { teams: TeamBody[]; canManage: boolean };
}

async function makeTeam(who: Member, name: string) {
  const answer = await ask(postTeam, '/api/teams', who, { body: { name } });
  expect(answer.status).toBe(201);
  return answer.body as TeamBody;
}

/**
 * Acme: Dana made it and owns it, Eli is an admin and Fay a member, and the owner put both in
 * the first team, as joining a workspace will once members can be added (project 3). Until then
 * nobody but its owner is in a team without being put there.
 */
async function acmeWithMembers() {
  const owner = await harness.member('owner');
  const admin = await harness.member('admin', { workspace: owner.workspaceId });
  const member = await harness.member('member', { workspace: owner.workspaceId });
  const [general] = (await teamsSeenBy(owner)).teams;
  if (!general) throw new Error('Acme has no first team');
  for (const joined of [admin, member]) {
    const path = `/api/teams/${general.id}/members/${joined.personId}`;
    expect((await ask(putTeamMember, path, owner)).status).toBe(200);
  }
  return { owner, admin, member, general };
}

/** The same people, sorted, so the order two were put in a team at once does not matter. */
const sorted = (ids: readonly string[]) => [...ids].sort();

describe('teams', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('start as one, the first team, made with the workspace with its owner in it', async () => {
    const owner = await harness.member('owner');
    expect(await teamsSeenBy(owner)).toEqual({
      teams: [
        {
          id: expect.any(String),
          name: FIRST_TEAM_NAME,
          first: true,
          memberIds: [owner.personId],
        },
      ],
      canManage: true,
    });
    // Joining the workspace puts nobody in a team yet.
    const admin = await harness.member('admin', { workspace: owner.workspaceId });
    expect((await teamsSeenBy(admin)).teams.map((team) => team.memberIds)).toEqual([
      [owner.personId],
    ]);
  });

  it('hold whoever an owner or admin puts in them', async () => {
    const { owner, admin, member } = await acmeWithMembers();
    const [general] = (await teamsSeenBy(owner)).teams;
    expect(general?.first).toBe(true);
    expect(sorted(general?.memberIds ?? [])).toEqual(
      sorted([owner.personId, admin.personId, member.personId]),
    );
  });

  it('are made, renamed and deleted by owners and admins', async () => {
    const { owner, admin } = await acmeWithMembers();
    const platform = await makeTeam(owner, 'Platform');
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
    const { owner } = await acmeWithMembers();
    const platform = await makeTeam(owner, 'Platform');
    await makeTeam(owner, 'Apps');
    expect(await ask(postTeam, '/api/teams', owner, { body: { name: 'PLATFORM' } })).toEqual({
      status: 409,
      body: { error: 'name_taken' },
    });
    expect(
      await ask(patchTeam, `/api/teams/${platform.id}`, owner, { body: { name: 'apps' } }),
    ).toEqual({ status: 409, body: { error: 'name_taken' } });
  });

  it('keep the first team: it can be renamed, never deleted', async () => {
    const { owner, general } = await acmeWithMembers();
    const path = `/api/teams/${general.id}`;
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
    const { owner } = await acmeWithMembers();
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
    const { owner, member } = await acmeWithMembers();
    const platform = await makeTeam(owner, 'Platform');
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

  it("take only the workspace's members, and let them go", async () => {
    const { owner, member } = await acmeWithMembers();
    const stranger = await harness.member('owner');
    const platform = await makeTeam(owner, 'Platform');
    const members = `/api/teams/${platform.id}/members`;

    // Someone nobody knows, and someone who is in another workspace alone.
    for (const personId of ['person-gus', stranger.personId]) {
      expect(await ask(putTeamMember, `${members}/${personId}`, owner)).toEqual({
        status: 409,
        body: { error: 'not_a_workspace_member' },
      });
    }
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

  it("of another workspace are none of the caller's: not found, never changed", async () => {
    const { owner } = await acmeWithMembers();
    const platform = await makeTeam(owner, 'Platform');
    // Sprocket, which Dana owns too, open in her session.
    const stranger = await makesWorkspace(owner, 'Sprocket');
    const path = `/api/teams/${platform.id}`;
    const notFound = { status: 404, body: { error: 'team_not_found' } };

    expect(await ask(patchTeam, path, stranger, { body: { name: 'Mine' } })).toEqual(notFound);
    expect(await ask(deleteTeam, path, stranger)).toEqual(notFound);
    expect(await ask(putTeamMember, `${path}/members/${owner.personId}`, stranger)).toEqual(
      notFound,
    );
    expect(await ask(deleteTeamMember, `${path}/members/${owner.personId}`, stranger)).toEqual(
      notFound,
    );
    expect((await teamsSeenBy(stranger)).teams.map((team) => team.name)).toEqual([FIRST_TEAM_NAME]);
    await opens(owner, owner.workspaceId);
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

async function makeFactory(who: Member, name: string, teamId: string) {
  const answer = await ask(postFactory, '/api/factories', who, { body: { name, teamId } });
  expect(answer.status).toBe(201);
  return answer.body as FactoryBody;
}

async function factoriesSeenBy(who: Member) {
  const answer = await ask(listFactories, '/api/factories', who);
  expect(answer.status).toBe(200);
  return (answer.body as { factories: FactoryBody[] }).factories.map((factory) => factory.name);
}

const saveFiles = (
  factoryId: string,
  who: Member,
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

  it('are made blank, naming the team that owns them, and read with their latest version', async () => {
    const { owner, member, general } = await acmeWithMembers();
    const deploys = await makeFactory(owner, 'Deploys', general.id);
    expect(deploys).toEqual({
      id: expect.any(String),
      name: 'Deploys',
      teamId: general.id,
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
    const { owner, admin, member, general } = await acmeWithMembers();
    const deploys = await makeFactory(owner, 'Deploys', general.id);

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
    const { owner, general } = await acmeWithMembers();
    const deploys = await makeFactory(owner, 'Deploys', general.id);
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
    const { owner, admin, member, general } = await acmeWithMembers();
    const platform = await makeTeam(owner, 'Platform');
    const deploys = await makeFactory(owner, 'Deploys', platform.id);
    await makeFactory(owner, 'Reviews', general.id);

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
    const { owner, admin, member, general } = await acmeWithMembers();
    const platform = await makeTeam(owner, 'Platform');
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

    await makeFactory(member, 'Deploys', general.id);
    expect(
      await ask(postFactory, '/api/factories', admin, {
        body: { name: 'DEPLOYS', teamId: general.id },
      }),
    ).toEqual({ status: 409, body: { error: 'name_taken' } });
    expect(
      await ask(postFactory, '/api/factories', admin, { body: { name: ' ', teamId: general.id } }),
    ).toEqual({ status: 400, body: { error: 'invalid_factory', problems: ['name_missing'] } });
    for (const body of [{ name: 'Mine' }, { name: 7, teamId: general.id }, 'not json']) {
      expect(await ask(postFactory, '/api/factories', owner, { body })).toEqual({
        status: 400,
        body: { error: 'invalid_request' },
      });
    }
  });

  it('are renamed and moved by whoever sees them, to a team they see', async () => {
    const { owner, admin, member, general } = await acmeWithMembers();
    const platform = await makeTeam(owner, 'Platform');
    const deploys = await makeFactory(owner, 'Deploys', general.id);
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
    const { owner, member, general } = await acmeWithMembers();
    const platform = await makeTeam(owner, 'Platform');
    const deploys = await makeFactory(owner, 'Deploys', platform.id);
    const reviews = await makeFactory(owner, 'Reviews', general.id);
    const factoryNotFound = { status: 404, body: { error: 'factory_not_found' } };
    const teamNotFound = { status: 404, body: { error: 'team_not_found' } };

    // Platform's factory is not the member's: not found, renamed or moved.
    for (const body of [{ name: 'Mine' }, { teamId: general.id }]) {
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
    const { owner, general } = await acmeWithMembers();
    const deploys = await makeFactory(owner, 'Deploys', general.id);
    await makeFactory(owner, 'Reviews', general.id);
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
    const { owner, admin, general } = await acmeWithMembers();
    const deploys = await makeFactory(owner, 'Deploys', general.id);
    expect((await saveFiles(deploys.id, owner, { baseVersion: 1, files: FILES })).status).toBe(201);
    for (const baseVersion of [1, 3, -1, 2 ** 40]) {
      expect(await saveFiles(deploys.id, admin, { baseVersion, files: [] })).toEqual({
        status: 409,
        body: { error: 'version_moved', latestVersion: 2 },
      });
    }
  });

  it('refuse a body that is not files, or larger than any factory', async () => {
    const { owner, general } = await acmeWithMembers();
    const deploys = await makeFactory(owner, 'Deploys', general.id);
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

  it("of another workspace are none of the caller's: not found, never saved", async () => {
    const { owner, general } = await acmeWithMembers();
    const deploys = await makeFactory(owner, 'Deploys', general.id);
    // Sprocket, which Dana owns too, open in her session.
    const stranger = await makesWorkspace(owner, 'Sprocket');
    const notFound = { status: 404, body: { error: 'factory_not_found' } };
    expect(await factoriesSeenBy(stranger)).toEqual([]);
    expect(await ask(getFactory, `/api/factories/${deploys.id}`, stranger)).toEqual(notFound);
    expect(await saveFiles(deploys.id, stranger, { baseVersion: 1, files: [] })).toEqual(notFound);
    expect(
      await ask(patchFactory, `/api/factories/${deploys.id}`, stranger, { body: { name: 'Mine' } }),
    ).toEqual(notFound);
    await opens(owner, owner.workspaceId);
    expect((await ask(getFactory, `/api/factories/${deploys.id}`, owner)).body).toMatchObject({
      factory: deploys,
    });
  });

  it('keep the team that owns them: it is not deleted', async () => {
    const { owner } = await acmeWithMembers();
    const platform = await makeTeam(owner, 'Platform');
    await makeFactory(owner, 'Deploys', platform.id);
    expect(await ask(deleteTeam, `/api/teams/${platform.id}`, owner)).toEqual({
      status: 409,
      body: { error: 'owns_factories' },
    });
  });
});
