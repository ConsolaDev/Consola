import { createHmac, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { CODE_REVIEW_TEAM_FILES } from '@consola/factory-spec';
import {
  PASS_AUDIENCE,
  PASS_MAX_LIFETIME_SECONDS,
  PASS_TYPE,
  readCellMessage,
  readPassClaims,
} from '@consola/runner-protocol';
import type { CellMessage } from '@consola/runner-protocol';
import { serve } from '@hono/node-server';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { asc, eq, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { compactVerify, importJWK } from 'jose';
import WebSocket from 'ws';
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
  getCloudSession,
  getCloudSessionOptions,
  getFactory,
  getFactoryVersion,
  getRun,
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
  postRunApproval,
  postTeam,
  putTeamMember,
} from './company/adapters/http/contract.js';
import { GITHUB_WEBHOOK_PATH, postGitHubWebhook } from './company/adapters/http/gitHubContract.js';
import { createGitHubStores } from './company/adapters/persistence/gitHubStores.js';
import { createDrizzleStores } from './company/adapters/persistence/stores.js';
import {
  cloudSessions,
  factories,
  factoryVersions,
  teamMembers,
  teams,
} from './company/adapters/persistence/tables.js';
import { recordRun } from './company/application/runs.js';
import { NO_STEP_DETAIL } from './company/domain/run.js';
import type { RunWrite, StepRecord } from './company/domain/run.js';
import { SLACK_EVENTS_PATH_PREFIX } from './company/domain/slack.js';
import { FIRST_TEAM_NAME } from './company/domain/team.js';
import { ROUTES } from './compose.js';
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
 * itself and says in the redirect that there is none; Slack's OAuth callback, a redirect whose
 * signed state says who started it; a factory's Slack events, signed instead (with Slack off, as
 * here, each is refused); and the runner's socket, behind the
 * runner's secret instead, which a bare request does not carry. Nothing else is open, but Better
 * Auth's own routes (`/api/auth/*`), where signing in happens.
 */
const OPEN_ROUTES: Record<string, number> = {
  'GET /api/health': 200,
  [`POST ${GITHUB_WEBHOOK_PATH}`]: 503,
  'GET /api/github/callback': 302,
  'GET /api/slack/oauth/callback': 302,
  [`POST ${SLACK_EVENTS_PATH_PREFIX}:factoryId`]: 503,
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
 * Every route the app holds, each once, though Hono lists a route once per handler in its chain:
 * all but Better Auth's (`/api/auth/*`) and the front door's origin check (`/api/*`). So a new
 * route is here without being named.
 */
function appRoutes(app: OpenAPIHono) {
  const listed = app.routes.filter(
    ({ method, path }) => !(method === 'ALL' && (path === '/api/*' || path === '/api/auth/*')),
  );
  return [...new Map(listed.map((route) => [`${route.method} ${route.path}`, route])).values()];
}

/** Company's routes among them: all but accounts', so GitHub's, the health check and the socket. */
const companyRoutes = (app: OpenAPIHono) =>
  appRoutes(app).filter(({ method, path }) => !ACCOUNTS_ROUTES.has(`${method} ${path}`));

/** A route's path with every parameter filled in. */
const filled = (path: string) => path.replaceAll(/:[^/]+/g, 'x');

/** The contract's route that Hono lists as `method` at `path` (`{param}` as `:param`). */
function contractRouteOf(method: string, path: string): ContractRoute {
  const declared = ROUTES.find(
    (route) =>
      route.method.toUpperCase() === method &&
      route.path.replaceAll(/\{([^}]+)\}/g, ':$1') === path,
  );
  if (declared === undefined) throw new Error(`${method} ${path} is in no part's contract`);
  return declared;
}

describe('every route', () => {
  it('but the open ones refuses a request without a session', async () => {
    for (const level of ['error', 'warn', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    const routes = appRoutes(harness.app);
    expect(companyRoutes(harness.app).length).toBeGreaterThan(20);
    expect(routes.length).toBeGreaterThan(companyRoutes(harness.app).length);
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
      ({ method, path }) =>
        CHANGES.has(method) &&
        path !== GITHUB_WEBHOOK_PATH &&
        !path.startsWith(SLACK_EVENTS_PATH_PREFIX),
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
        const answer = await answerOf(contractRouteOf(method, path), response);
        expect([route, origin, answer]).toEqual([route, origin, { error: 'bad_origin' }]);
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
  conversation: null,
  summary: 'Built.',
  error: null,
  costUsd: 0.1,
  createdAt: minute(0),
  startedAt: minute(0),
  finishedAt: minute(1),
  updatedAt: minute(1),
  ...overrides,
});

/** A request `startedBy` made of `factoryId`'s orchestrator, waiting on the run it started. */
const personsRequest = (
  id: string,
  factoryId: string,
  startedBy: string,
  overrides: Partial<RunWrite> = {},
) =>
  cronRun(id, factoryId, {
    automation: null,
    status: 'waiting',
    waitingOn: 'run',
    trigger: 'manual',
    triggerDetail: null,
    startedBy,
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

/** Records each run in the workspace through the store, as a runner will. */
async function recordRuns(workspaceId: string, ...runs: RunWrite[]) {
  const store = createDrizzleStores(harness.db.company).runs;
  for (const run of runs) {
    const recorded = await recordRun(store, workspaceId, run);
    expect([run.id, recorded.kind]).toEqual([run.id, 'recorded']);
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

async function runsSeenBy(who: Member, search = '') {
  const answer = await ask(listRuns, `/api/runs${search}`, who);
  expect(answer.status).toBe(200);
  return answer.body as RunListBody;
}

/** Acme with a Platform team nobody is in yet: General owns Reviews, Platform Deploys. */
async function acmeWithFactories() {
  const acme = await acmeWithMembers();
  const platform = await makeTeam(acme.owner, 'Platform');
  const reviews = await makeFactory(acme.owner, 'Reviews', acme.general.id);
  const deploys = await makeFactory(acme.owner, 'Deploys', platform.id);
  return { ...acme, platform, reviews, deploys };
}

describe('runs', () => {
  it('list the runs of the factories the caller sees, newest first, with counts and facets', async () => {
    const { owner, member, general, platform, reviews, deploys } = await acmeWithFactories();
    await recordRuns(
      owner.workspaceId,
      cronRun('reviews-nightly', reviews.id),
      personsRequest('ship', reviews.id, member.personId, { createdAt: minute(5) }),
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
    const { owner, member, reviews } = await acmeWithFactories();
    await recordRuns(
      owner.workspaceId,
      personsRequest('ship', reviews.id, member.personId),
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
    const { owner, member, reviews } = await acmeWithFactories();
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
    await recordRuns(
      owner.workspaceId,
      cronRun('nightly-v2', reviews.id, { factoryVersion: 2, steps: [build] }),
    );

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
    const { owner, admin, member, deploys } = await acmeWithFactories();
    await recordRuns(owner.workspaceId, cronRun('deploys-nightly', deploys.id));
    const notFound = { status: 404, body: { error: 'run_not_found' } };
    expect(await ask(getRun, '/api/runs/deploys-nightly', member)).toEqual(notFound);
    expect(await ask(getRun, '/api/runs/nothing', owner)).toEqual(notFound);
    expect((await ask(getRun, '/api/runs/deploys-nightly', admin)).status).toBe(200);
    expect((await runsSeenBy(member, `?factoryId=${deploys.id}`)).runs).toEqual([]);

    // Sprocket, which Dana owns too, open in her session.
    const stranger = await makesWorkspace(owner, 'Sprocket');
    expect(await ask(getRun, '/api/runs/deploys-nightly', stranger)).toEqual(notFound);
    expect((await runsSeenBy(stranger)).runs).toEqual([]);
    expect((await runsSeenBy(stranger, `?factoryId=${deploys.id}`)).runs).toEqual([]);
  });

  it('take a filter given once or repeated, page by the cursor, and ignore what they do not know', async () => {
    const { owner, member, reviews } = await acmeWithFactories();
    await recordRuns(
      owner.workspaceId,
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
    const { member } = await acmeWithFactories();
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

  describe('waiting for approval', () => {
    const answerAs = (who: Member, runId: string, body: unknown) =>
      ask(postRunApproval, `/api/runs/${runId}/approval`, who, { body });
    const waiting = { status: 'needs-approval', startedAt: null, finishedAt: null } as const;

    /** A run of Reviews (General: everyone) and one of Deploys (Platform: nobody yet), waiting. */
    async function acmeWaiting() {
      const made = await acmeWithFactories();
      const saved = await saveFiles(made.reviews.id, made.owner, {
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
        made.owner.workspaceId,
        cronRun('reviews-wait', made.reviews.id, { ...waiting, factoryVersion: 2 }),
        cronRun('deploys-wait', made.deploys.id, waiting),
        cronRun('reviews-done', made.reviews.id, { factoryVersion: 2 }),
      );
      return made;
    }

    it('show the run its approval and the file behind it', async () => {
      const { member, general } = await acmeWaiting();
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
      const { owner, admin, member } = await acmeWaiting();
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
      const { owner, member, platform } = await acmeWaiting();
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
      const { member } = await acmeWaiting();
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

// Agent runs: a GitHub event a workspace records for the first time starts them, through the
// GitHub App's webhook, signed as GitHub signs it.

/** The GitHub App's webhook secret on the app restarted to receive webhooks: a stand-in. */
const WEBHOOK_SECRET = 'sprocket-webhook-secret-0123456789abcdef';

/** The installation of Consola's GitHub App on the sprocket organisation, which Acme connects. */
const INSTALLATION_ID = 41;

/** `owner`'s workspace holds the installation, as a finished Connect leaves it. */
async function connectsGitHub(owner: Member) {
  const { installations } = createGitHubStores(harness.db.company);
  const connected = await installations.connect({
    installation: {
      id: INSTALLATION_ID,
      account: { id: 9001, login: 'sprocket', type: 'Organization' },
    },
    workspaceId: owner.workspaceId,
    connectedBy: owner.personId,
    at: new Date(),
  });
  expect(connected).toBe('connected');
}

/** POSTs `payload` to `app`'s webhook route as GitHub does, and reads the answer by the contract. */
async function deliverWebhook(
  app: OpenAPIHono,
  delivery: { event: string; deliveryId: string; payload: unknown },
) {
  const body = JSON.stringify(delivery.payload);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  const response = await app.request(GITHUB_WEBHOOK_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': delivery.event,
      'x-github-delivery': delivery.deliveryId,
      'x-hub-signature-256': `sha256=${signature}`,
    },
    body,
  });
  return { status: response.status, body: await answerOf(postGitHubWebhook, response) };
}

/** A pull request opened in the `sprocket` organisation's repository, as GitHub POSTs it. */
const PULL_REQUEST_OPENED = {
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
  installation: { id: INSTALLATION_ID },
};

/** The code review team's files, as a save sends them. */
const CODE_REVIEW_TEAM = CODE_REVIEW_TEAM_FILES.map(({ path, content }) => ({ path, content }));

/** Every line the app writes to the console while a test runs. */
function captureLogs(): () => string {
  const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
  return () => spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n');
}

describe('agent teams', () => {
  it('offer the code review team as a template, its files as factory-spec writes them', async () => {
    const member = await harness.member('member');
    const answer = await ask(listFactoryTemplates, '/api/factory-templates', member);
    expect(answer).toEqual({
      status: 200,
      body: [
        {
          id: 'code-review-team',
          name: 'Code review team',
          description: expect.any(String),
          files: CODE_REVIEW_TEAM,
        },
      ],
    });
  });

  it("save beside the steps design's files with no issue, and refuse a team's problems by file", async () => {
    const { owner, member, general } = await acmeWithMembers();
    const factory = await makeFactory(owner, 'Reviews', general.id);
    const both = [...FILES, ...CODE_REVIEW_TEAM];
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

  it('start an agent run on an opened pull request, which every member sees in Runs, failed when no runner is connected', async () => {
    const logs = captureLogs();
    const { owner, member, general } = await acmeWithMembers();
    const factory = await makeFactory(owner, 'Reviews', general.id);
    await saveFiles(factory.id, owner, { baseVersion: 1, files: CODE_REVIEW_TEAM });
    await connectsGitHub(owner);
    const github = await harness.restart({ GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET });

    const delivery = {
      event: 'pull_request',
      deliveryId: '5e1f0a2c-0001',
      payload: PULL_REQUEST_OPENED,
    };
    expect(await deliverWebhook(github.app, delivery)).toEqual({
      status: 201,
      body: { result: 'recorded' },
    });
    // Delivered again: recorded before, so it starts nothing more.
    expect(await deliverWebhook(github.app, delivery)).toEqual({
      status: 409,
      body: { error: 'duplicate_delivery' },
    });

    // The run is in Runs, a request whose conversation is its session; no one's Sessions list
    // holds it.
    const listed = await ask(listRuns, '/api/runs', member);
    expect(listed.status).toBe(200);
    const runs = (listed.body as { runs: Array<{ id: string }> }).runs;
    expect(runs).toEqual([
      expect.objectContaining({
        kind: 'request',
        status: 'failed',
        trigger: 'event',
        title: 'Price the catalog in euros',
        error: 'No runner was connected for this workspace, so nothing ran.',
        factory: expect.objectContaining({ id: factory.id }),
      }),
    ]);
    const id = runs[0]?.id ?? '';
    const read = await ask(getRun, `/api/runs/${id}`, member);
    expect(read).toMatchObject({ status: 200, body: { conversation: { sessionId: id } } });
    expect(await ask(listCloudSessions, '/api/cloud-sessions', member)).toEqual({
      status: 200,
      body: [],
    });
    const session = await ask(getCloudSession, `/api/cloud-sessions/${id}`, member);
    expect(session).toEqual({
      status: 200,
      body: expect.objectContaining({
        personId: null,
        runnerId: null,
        status: 'failed',
        errorCode: 'runner_unavailable',
        title: 'review-pull-requests · sprocket/catalog-portal#7 Price the catalog in euros',
        origin: expect.objectContaining({ factoryId: factory.id, agent: 'orchestrator' }),
        agentRun: null,
      }),
    });
    // Ids and names reach the log, never what the event says.
    expect(logs()).not.toContain('Lyon');
    expect(logs()).not.toContain(WEBHOOK_SECRET);
  });
});

describe('cloud sessions, with no runner configured (the channel when no runner socket is set up)', () => {
  const start = { repository: 'sprocket/catalog-portal', harness: 'claude' };

  it('answers 503 {"error":"no_runner"} to a start and records nothing', async () => {
    const person = await harness.member('member');
    const response = await harness.app.request('/api/cloud-sessions', {
      method: 'POST',
      headers: person.headers,
      body: JSON.stringify(start),
    });
    expect(response.status).toBe(503);
    expect(await answerOf(postCloudSession, response.clone())).toEqual({ error: 'no_runner' });
    expect(await response.text()).toBe('{"error":"no_runner"}');
    expect(await harness.db.company.select().from(cloudSessions)).toEqual([]);
  });

  it('answers 503 no_runner to the options', async () => {
    const person = await harness.member('member');
    expect(await ask(getCloudSessionOptions, '/api/cloud-sessions/options', person)).toEqual({
      status: 503,
      body: { error: 'no_runner' },
    });
  });

  it('lists none, and holds no session by any id', async () => {
    const person = await harness.member('member');
    expect(await ask(listCloudSessions, '/api/cloud-sessions', person)).toEqual({
      status: 200,
      body: [],
    });
    expect(await ask(getCloudSession, '/api/cloud-sessions/session-1', person)).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
    expect(await ask(postCloudSessionStop, '/api/cloud-sessions/session-1/stop', person)).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
  });

  it('checks the session before the body', async () => {
    const person = await harness.member('member');
    expect(await ask(postCloudSession, '/api/cloud-sessions', person, { body: '{nope' })).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
    const headers = bare(person.workspaceId);
    headers.set('content-type', 'text/plain');
    const response = await harness.app.request('/api/cloud-sessions', {
      method: 'POST',
      headers,
      body: '{nope',
    });
    expect(response.status).toBe(401);
    expect(await answerOf(postCloudSession, response)).toEqual({ error: 'signed_out' });
  });

  it('needs a session', async () => {
    const listed = await harness.app.request('/api/cloud-sessions', { headers: bare() });
    expect(listed.status).toBe(401);
    expect(await answerOf(listCloudSessions, listed)).toEqual({ error: 'signed_out' });
    const started = await harness.app.request('/api/cloud-sessions', {
      method: 'POST',
      headers: bare(),
    });
    expect(started.status).toBe(401);
    expect(await answerOf(postCloudSession, started)).toEqual({ error: 'signed_out' });
  });
});

/** `vi.waitFor` with a timeout in line with the suite's own, so a loaded machine does not flake. */
const waitFor = <T>(callback: () => T | Promise<T>) =>
  vi.waitFor(callback, { timeout: 10_000, interval: 25 });

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe('a runner and its passes', () => {
  // Stand-ins, never real credentials.
  const RUNNER_SECRET = 'sprocket-runner-secret-0123456789abcdef';
  const passJwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as Record<
    string,
    unknown
  >;
  /** The runner's settings, for a runner that serves `workspaceId`. */
  const runnerFor = (workspaceId: string) => ({
    RUNNER_SECRET,
    RUNNER_WORKSPACE_ID: workspaceId,
    PASS_PRIVATE_KEY: JSON.stringify(passJwk),
  });

  /** A session row as runner-1 holds it for `who`, in their workspace. */
  const held = (
    id: string,
    status: 'starting' | 'running',
    who: { personId: string; workspaceId: string },
  ) => ({
    id,
    workspaceId: who.workspaceId,
    personId: who.personId,
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

  it('refuses an app that has a runner but a pass key that is no Ed25519 key, at compose', async () => {
    const x25519 = generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
    await expect(
      harness.restart({ ...runnerFor('acme'), PASS_PRIVATE_KEY: JSON.stringify(x25519) }),
    ).rejects.toThrow(/^The configuration is not valid:\n {2}- PASS_PRIVATE_KEY: /);
  });

  it("signs a pass for the caller's running session, which the derived key verifies", async () => {
    const logs = captureLogs();
    const person = await harness.member('member');
    const runner = await harness.restart(runnerFor(person.workspaceId));
    await harness.db.company.insert(cloudSessions).values(held('session-1', 'running', person));

    const response = await runner.app.request('/api/cloud-sessions/session-1/pass', {
      method: 'POST',
      headers: person.headers,
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
      sub: person.personId,
      ws: person.workspaceId,
      sid: 'session-1',
    });
    expect(claims.value.exp - claims.value.iat).toBe(PASS_MAX_LIFETIME_SECONDS);
    expect(body.expiresAt).toBe(claims.value.exp);

    // Nothing the app logged holds the pass or the key that signs it.
    expect(logs()).not.toContain(body.pass);
    expect(logs()).not.toContain(String(passJwk.d));
  });

  it("is 404 not_found for a starting session, another person's, or an unknown id", async () => {
    const logs = captureLogs();
    const person = await harness.member('member');
    const other = await harness.member('member', { workspace: person.workspaceId });
    const runner = await harness.restart(runnerFor(person.workspaceId));
    await harness.db.company
      .insert(cloudSessions)
      .values([held('session-1', 'starting', person), held('session-2', 'running', other)]);

    for (const id of ['session-1', 'session-2', 'nope']) {
      const response = await runner.app.request(`/api/cloud-sessions/${id}/pass`, {
        method: 'POST',
        headers: person.headers,
      });
      expect([id, response.status]).toEqual([id, 404]);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await answerOf(postCloudSessionPass, response)).toEqual({ error: 'not_found' });
    }
    expect(logs()).not.toContain(String(passJwk.d));
  });

  it('is 503 no_runner on an app with no runner, and so no pass key', async () => {
    const person = await harness.member('member');
    await harness.db.company.insert(cloudSessions).values(held('session-1', 'running', person));
    const response = await harness.app.request('/api/cloud-sessions/session-1/pass', {
      method: 'POST',
      headers: person.headers,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await answerOf(postCloudSessionPass, response)).toEqual({ error: 'no_runner' });
  });

  it("starts a session on the runner's socket, wired as main.ts wires it", async () => {
    const logs = captureLogs();
    const person = await harness.member('member');
    const runner = await harness.restart(runnerFor(person.workspaceId));
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const started = serve({ fetch: runner.app.fetch, hostname: '127.0.0.1', port: 0 }, () =>
        resolve(started),
      );
      runner.api.injectWebSocket(started);
    });
    const port = (server.address() as AddressInfo).port;

    // A bare upgrade, and ones with the person's session in place of the secret, are refused.
    const cookie = person.headers.get('cookie') ?? '';
    for (const headers of [
      {},
      { cookie },
      { authorization: `Bearer ${cookieParts(cookie).token}` },
    ]) {
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
    await waitFor(async () => {
      const options = await runner.app.request('/api/cloud-sessions/options', {
        headers: person.headers,
      });
      expect(options.status).toBe(200);
      expect(await answerOf(getCloudSessionOptions, options)).toEqual({
        repositories: ['sprocket/catalog-portal'],
        harnesses: ['claude'],
      });
    });

    const started = await runner.app.request('/api/cloud-sessions', {
      method: 'POST',
      headers: person.headers,
      body: JSON.stringify({ repository: 'sprocket/catalog-portal', harness: 'claude' }),
    });
    expect(started.status).toBe(201);
    const session = (await answerOf(postCloudSession, started)) as { id: string; status: string };
    expect(session.status).toBe('starting');
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      type: 'session.start',
      sessionId: session.id,
      workspaceId: person.workspaceId,
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
      const pass = await runner.app.request(`/api/cloud-sessions/${session.id}/pass`, {
        method: 'POST',
        headers: person.headers,
      });
      expect(pass.status).toBe(200);
      expect(await answerOf(postCloudSessionPass, pass)).toMatchObject({
        hostUrl: 'https://3000-sandbox.e2b.example',
      });
    });
    const reread = await runner.app.request(`/api/cloud-sessions/${session.id}`, {
      headers: person.headers,
    });
    expect(await answerOf(getCloudSession, reread)).toMatchObject({
      id: session.id,
      status: 'running',
      hostUrl: 'https://3000-sandbox.e2b.example',
      runnerId: 'runner-1',
    });
    // Its person lists it, and stops it, which the runner is told.
    expect(
      (await ask(listCloudSessions, '/api/cloud-sessions', person, { app: runner.app })).body,
    ).toEqual([expect.objectContaining({ id: session.id, status: 'running' })]);
    const stopped = await ask(
      postCloudSessionStop,
      `/api/cloud-sessions/${session.id}/stop`,
      person,
      { app: runner.app },
    );
    expect(stopped).toMatchObject({ status: 202, body: { id: session.id, status: 'stopped' } });
    await waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toMatchObject({ type: 'session.stop', sessionId: session.id });

    expect(logs()).not.toContain(RUNNER_SECRET);
    expect(logs()).not.toContain(String(passJwk.d));
    socket.terminate();
    runner.api.closeRunnerSockets();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

/** Every company row a change could write, whatever its workspace, in a fixed order. */
async function companyRows() {
  const { company } = harness.db;
  return {
    teams: await company.select().from(teams).orderBy(asc(teams.workspaceId), asc(teams.teamId)),
    places: await company
      .select()
      .from(teamMembers)
      .orderBy(asc(teamMembers.workspaceId), asc(teamMembers.teamId), asc(teamMembers.personId)),
    factories: await company.select().from(factories).orderBy(asc(factories.factoryId)),
    versions: await company
      .select()
      .from(factoryVersions)
      .orderBy(asc(factoryVersions.factoryId), asc(factoryVersions.version)),
    sessions: await company.select().from(cloudSessions).orderBy(asc(cloudSessions.id)),
  };
}

describe('who is asking, read on every request', () => {
  it('refuses a change from a page whose workspace another tab switched, and writes nothing in either', async () => {
    const { owner, admin, general } = await acmeWithMembers();
    const deploys = await makeFactory(owner, 'Deploys', general.id);
    // In another tab, Dana makes Sprocket, which her session then opens.
    const sprocket = await makesWorkspace(owner, 'Sprocket');
    const before = await companyRows();

    // Acme's page, still open, still says it shows Acme.
    const switched = { status: 409, body: { error: 'workspace_switched' } };
    const changes: Array<[ContractRoute, string, unknown]> = [
      [postTeam, '/api/teams', { name: 'Platform' }],
      [patchTeam, `/api/teams/${general.id}`, { name: 'Everyone' }],
      [deleteTeamMember, `/api/teams/${general.id}/members/${admin.personId}`, undefined],
      [postFactory, '/api/factories', { name: 'Reviews', teamId: general.id }],
      [patchFactory, `/api/factories/${deploys.id}`, { name: 'Ship it' }],
      [
        postFactoryVersion,
        `/api/factories/${deploys.id}/versions`,
        { baseVersion: 1, files: FILES },
      ],
      [postCloudSession, '/api/cloud-sessions', { repository: 'sprocket/x', harness: 'claude' }],
    ];
    for (const [route, path, body] of changes) {
      const answer = await ask(route, path, owner, { body });
      expect([route.method, path, answer]).toEqual([route.method, path, switched]);
    }
    // A read is refused too: the page would show the other workspace's rows as Acme's.
    expect(await ask(listTeams, '/api/teams', owner)).toEqual(switched);
    expect(await companyRows()).toEqual(before);

    // Sprocket holds its first team alone, and Acme, once open again, is as it was.
    expect((await teamsSeenBy(sprocket)).teams.map((team) => team.name)).toEqual([FIRST_TEAM_NAME]);
    expect(await factoriesSeenBy(sprocket)).toEqual([]);
    await opens(owner, owner.workspaceId);
    const acme = await teamsSeenBy(owner);
    expect(acme.teams.map((team) => team.name)).toEqual([FIRST_TEAM_NAME]);
    expect(acme.teams[0]?.memberIds).toContain(admin.personId);
    expect(await factoriesSeenBy(owner)).toEqual(['Deploys']);
    // Now the page for Sprocket is the stale one.
    expect(await ask(postTeam, '/api/teams', sprocket, { body: { name: 'Apps' } })).toEqual(
      switched,
    );
  });

  it('acts with a role changed in `member` from the very next request, and back', async () => {
    const { owner, admin } = await acmeWithMembers();
    expect((await ask(postTeam, '/api/teams', admin, { body: { name: 'Apps' } })).status).toBe(201);

    // The same session and the same page: the very next change is a member's.
    await harness.setRole(admin.personId, owner.workspaceId, 'member');
    expect(await ask(postTeam, '/api/teams', admin, { body: { name: 'Design' } })).toEqual({
      status: 403,
      body: { error: 'not_allowed' },
    });
    const demoted = await teamsSeenBy(admin);
    expect(demoted.canManage).toBe(false);
    // A member sees only the teams they are in.
    expect(demoted.teams.map((team) => team.name)).toEqual([FIRST_TEAM_NAME]);

    await harness.setRole(admin.personId, owner.workspaceId, 'admin');
    expect((await ask(postTeam, '/api/teams', admin, { body: { name: 'Design' } })).status).toBe(
      201,
    );
    expect((await teamsSeenBy(admin)).teams.map((team) => team.name)).toEqual([
      FIRST_TEAM_NAME,
      'Apps',
      'Design',
    ]);
  });

  it('refuses a person removed from `member` on their very next request to any company route, and their teams forget them', async () => {
    for (const level of ['error', 'warn', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    const { owner, admin, member } = await acmeWithMembers();
    const platform = await makeTeam(owner, 'Platform');
    await ask(putTeamMember, `/api/teams/${platform.id}/members/${member.personId}`, owner);
    expect((await ask(listTeams, '/api/teams', member)).status).toBe(200);

    await harness.removeMember(member.personId, owner.workspaceId);

    const routes = companyRoutes(harness.app).filter(
      ({ method, path }) => !(`${method} ${path}` in OPEN_ROUTES),
    );
    expect(routes.length).toBeGreaterThan(20);
    for (const { method, path } of routes) {
      const response = await harness.app.request(filled(path), {
        method,
        headers: member.headers,
        body: method === 'GET' ? undefined : '{}',
      });
      const route = `${method} ${path}`;
      expect([route, response.status, await response.json()]).toEqual([
        route,
        403,
        { error: 'not_a_member' },
      ]);
    }

    // The admin who stays sees no team that lists them.
    const seen = await teamsSeenBy(admin);
    expect(seen.teams.map((team) => [team.name, sorted(team.memberIds)])).toEqual([
      [FIRST_TEAM_NAME, sorted([owner.personId, admin.personId])],
      ['Platform', []],
    ]);
    // Nor can one take them back: they are no member to put in it.
    expect(
      await ask(putTeamMember, `/api/teams/${platform.id}/members/${member.personId}`, admin),
    ).toEqual({ status: 409, body: { error: 'not_a_workspace_member' } });
  });
});
