import { createHmac, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from './company/adapters/clock/systemClock.js';
import { createGitHubApp, loadGitHubAppKey } from './company/adapters/github/gitHubApp.js';
import { GITHUB_CALLBACK_RESULTS } from './company/adapters/http/gitHubContract.js';
import { createGitHubStores } from './company/adapters/persistence/gitHubStores.js';
import {
  gitHubEvents,
  githubInstallation,
  githubTokenMint,
} from './company/adapters/persistence/gitHubTables.js';
import { mintGitHubToken } from './company/application/gitHubTokens.js';
import type { GitHubTokenRequest } from './company/application/gitHubTokens.js';
import { INSTALL_STATE_LIFETIME_SECONDS } from './company/domain/connections.js';
import { GITHUB_PAYLOAD_MAX_BYTES } from './company/domain/webhooks.js';
import { ROUTES } from './compose.js';
import { ConfigError } from './config.js';
import { startApi } from './testing/harness.js';
import type { Harness, Member } from './testing/harness.js';

// GitHub's routes on the app as `main.ts` composes it (`startApi`, through `composeApi`), with
// GitHub itself behind `fetch`: Connections, Connect and GitHub's callback, Disconnect, the
// webhooks and the agent runs an event starts, and the tokens the app mints for a workspace's own
// work (`mintGitHubToken`, an in-app use case on the composition's stores, which no route serves).

let harness: Harness;
// True while no app is open: before the first test starts one, and after each test closes it.
let closed = true;

/** The app on a fresh database, with `environment` over the harness's stand-in configuration. */
async function start(environment: Record<string, string> = {}) {
  harness = await startApi({ environment });
  closed = false;
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

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDatabase();
});

// A key made for this run only, never one written down, in a folder of its own.
const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const appKeyLine = appKey.export({ type: 'pkcs1', format: 'pem' }).toString().split('\n')[1] ?? '';
let keyFolder: string;
let privateKeyPath: string;

beforeAll(async () => {
  keyFolder = await mkdtemp(join(tmpdir(), 'consola-github-app-'));
  privateKeyPath = join(keyFolder, 'app.pem');
  await writeFile(privateKeyPath, appKey.export({ type: 'pkcs1', format: 'pem' }));
});

afterAll(async () => {
  await rm(keyFolder, { recursive: true, force: true });
});

const CLIENT_SECRET = 'sprocket-test-github-client-secret';
// A secret made up for these tests: the app's real one lives only in .env.
const WEBHOOK_SECRET = 'sprocket-test-webhook-secret-0123456789abcdef';

/** The GitHub App's settings, as `.env` names them, with this run's key. */
const withGitHubApp = () => ({
  GITHUB_APP_CLIENT_ID: 'Iv23liSprocketTest',
  GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
  GITHUB_APP_SLUG: 'consola-dev',
  GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath,
});

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

/**
 * A change a page sends, as `headers`' session: JSON, from the web origin, its workspace named.
 * `route` is the contract's path for it, when `path` fills in its parameters.
 */
async function send(
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
  headers: Headers,
  route = path,
) {
  const response = await harness.app.request(path, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  return answerOf(method, route, response);
}

/** Only the session cookie of `headers`: what a browser brings back on a redirect. */
const cookieOf = (headers: Headers) => new Headers({ cookie: headers.get('cookie') ?? '' });

describe('GitHub as a connection', () => {
  /** Who GitHub says can reach which installations, by the code their redirect carries. */
  let reachable: Record<string, Array<{ id: number; login: string; type: string }>>;
  /** The codes of people who are only members of the organisations they reach; others own them. */
  let membersOnly: Set<string>;
  /** When set, GitHub refuses to exchange any code, as it does while it is down. */
  let gitHubDown: boolean;
  let seen: Array<{ method: string; url: string; body: string }>;

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
        if (gitHubDown) return new Response('Bad gateway', { status: 502 });
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
    gitHubDown = false;
    await start(withGitHubApp());
    fakeGitHub();
  });

  async function startConnect(headers: Headers) {
    const response = await harness.app.request('/api/connections/github/install', {
      method: 'POST',
      headers,
    });
    const answer = await answerOf('POST', '/api/connections/github/install', response);
    return { ...answer, headers: response.headers };
  }

  /** The state Consola's install link carries, for a Connect `headers`' session starts. */
  async function stateFor(headers: Headers) {
    const started = await startConnect(headers);
    expect(started.status).toBe(200);
    return new URL(started.body.url).searchParams.get('state') ?? '';
  }

  /** Disconnects installation `id` as the web app does; an answer with a body is checked. */
  async function disconnect(id: string, headers: Headers) {
    const response = await harness.app.request(`/api/connections/github/installations/${id}`, {
      method: 'DELETE',
      headers,
    });
    if (response.status === 204) return { status: 204, body: null };
    return answerOf('DELETE', '/api/connections/github/installations/{installationId}', response);
  }

  /** GitHub sending the browser back: where the browser goes next, and with what result. */
  async function returnFromGitHub(headers: Headers, query: Record<string, string>) {
    const response = await harness.app.request(
      `/api/github/callback?${new URLSearchParams(query).toString()}`,
      { headers: cookieOf(headers) },
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
    const state = await stateFor(headers);
    return returnFromGitHub(headers, {
      code,
      installation_id: String(installationId),
      setup_action: 'install',
      state,
    });
  }

  const sprocketOrg = { id: 41, login: 'sprocket', type: 'Organization' };
  const storedInstallations = () => harness.db.company.select().from(githubInstallation);

  it('every route is 401 signed out, and the callback sends the browser back signed out', async () => {
    expect(await get('/api/connections')).toEqual({ status: 401, body: { error: 'signed_out' } });
    expect((await startConnect(new Headers({ origin: harness.config.publicUrl }))).status).toBe(
      401,
    );
    expect(await disconnect('41', new Headers({ origin: harness.config.publicUrl }))).toEqual({
      status: 401,
      body: { error: 'signed_out' },
    });
    expect((await returnFromGitHub(new Headers(), { code: 'x' })).result).toBe('signed_out');
  });

  it('an owner connects GitHub, and the page shows the installation and its repositories', async () => {
    const dana = await harness.member('owner');
    reachable = { 'dana-code': [sprocketOrg] };

    const started = await startConnect(dana.headers);
    expect(started.status).toBe(200);
    expect(started.headers.get('cache-control')).toBe('no-store');
    const url = new URL(started.body.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://github.com/apps/consola-dev/installations/new',
    );

    const back = await returnFromGitHub(dana.headers, {
      code: 'dana-code',
      installation_id: '41',
      setup_action: 'install',
      state: url.searchParams.get('state') ?? '',
    });
    expect(back.status).toBe(302);
    expect(back.location).toBe(
      `${harness.config.publicUrl}/?github=connected#/settings/connections`,
    );
    expect(back.headers.get('referrer-policy')).toBe('no-referrer');
    expect(back.headers.get('cache-control')).toBe('no-store');

    expect(await get('/api/connections', dana.headers)).toEqual({
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
    const [row, ...more] = await storedInstallations();
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      installationId: 41,
      workspaceId: dana.workspaceId,
      connectedBy: dana.personId,
    });
    // The person's token was revoked once read.
    expect(
      seen.some((call) => call.method === 'DELETE' && call.body.includes('ghu_dana-code')),
    ).toBe(true);
  });

  describe("GitHub's callback", () => {
    /** A Connect that ends as `?github=` names it, for each way the contract lists. */
    const ENDINGS: Record<(typeof GITHUB_CALLBACK_RESULTS)[number], () => Promise<string | null>> =
      {
        async connected() {
          const owner = await harness.member('owner');
          reachable = { 'owner-code': [sprocketOrg] };
          return (await connect(owner.headers, 41, 'owner-code')).result;
        },
        async already_connected() {
          const owner = await harness.member('owner');
          reachable = { 'owner-code': [sprocketOrg] };
          expect((await connect(owner.headers, 41, 'owner-code')).result).toBe('connected');
          return (await connect(owner.headers, 41, 'owner-code')).result;
        },
        async requested() {
          // A member of an organisation, not its owner, asks its owners to install the app.
          const owner = await harness.member('owner');
          const state = await stateFor(owner.headers);
          return (await returnFromGitHub(owner.headers, { state, setup_action: 'request' })).result;
        },
        async cancelled() {
          const owner = await harness.member('owner');
          const state = await stateFor(owner.headers);
          return (await returnFromGitHub(owner.headers, { state, error: 'access_denied' })).result;
        },
        async bad_state() {
          const owner = await harness.member('owner');
          reachable = { 'owner-code': [sprocketOrg] };
          return (
            await returnFromGitHub(owner.headers, {
              code: 'owner-code',
              installation_id: '41',
              state: 'not-a-state',
            })
          ).result;
        },
        async expired() {
          const owner = await harness.member('owner');
          reachable = { 'owner-code': [sprocketOrg] };
          const state = await stateFor(owner.headers);
          const later = Date.now() + (INSTALL_STATE_LIFETIME_SECONDS + 1) * 1000;
          vi.spyOn(Date, 'now').mockReturnValue(later);
          return (
            await returnFromGitHub(owner.headers, {
              code: 'owner-code',
              installation_id: '41',
              state,
            })
          ).result;
        },
        async not_allowed() {
          // An owner who starts a Connect, and is made a member before GitHub sends them back.
          const owner = await harness.member('owner');
          reachable = { 'owner-code': [sprocketOrg] };
          const state = await stateFor(owner.headers);
          await harness.setRole(owner.personId, owner.workspaceId, 'member');
          return (
            await returnFromGitHub(owner.headers, {
              code: 'owner-code',
              installation_id: '41',
              state,
            })
          ).result;
        },
        async code_refused() {
          const owner = await harness.member('owner');
          reachable = { 'owner-code': [sprocketOrg] };
          return (await connect(owner.headers, 41, 'used-code')).result;
        },
        async not_installer() {
          const owner = await harness.member('owner');
          reachable = { 'owner-code': [{ id: 52, login: 'dana', type: 'User' }] };
          return (await connect(owner.headers, 41, 'owner-code')).result;
        },
        async not_account_admin() {
          const owner = await harness.member('owner');
          reachable = { 'owner-code': [sprocketOrg] };
          membersOnly = new Set(['owner-code']);
          return (await connect(owner.headers, 41, 'owner-code')).result;
        },
        async taken() {
          const first = await harness.member('owner');
          const second = await harness.member('owner');
          reachable = { 'first-code': [sprocketOrg], 'second-code': [sprocketOrg] };
          expect((await connect(first.headers, 41, 'first-code')).result).toBe('connected');
          return (await connect(second.headers, 41, 'second-code')).result;
        },
        async invalid() {
          const owner = await harness.member('owner');
          reachable = { 'owner-code': [sprocketOrg] };
          const state = await stateFor(owner.headers);
          return (
            await returnFromGitHub(owner.headers, {
              code: 'owner-code',
              installation_id: 'forty-one',
              state,
            })
          ).result;
        },
        async unavailable() {
          const owner = await harness.member('owner');
          reachable = { 'owner-code': [sprocketOrg] };
          gitHubDown = true;
          return (await connect(owner.headers, 41, 'owner-code')).result;
        },
        async not_configured() {
          await restart({});
          const owner = await harness.member('owner');
          return (await returnFromGitHub(owner.headers, { code: 'x', state: 'any' })).result;
        },
        async signed_out() {
          return (await returnFromGitHub(new Headers(), { code: 'x', state: 'any' })).result;
        },
      };

    it('names every result the contract lists, and no other', () => {
      expect(Object.keys(ENDINGS).sort()).toEqual([...GITHUB_CALLBACK_RESULTS].sort());
    });

    it.each(GITHUB_CALLBACK_RESULTS)('ends a Connect as %s', async (result) => {
      logged();
      expect(await ENDINGS[result]()).toBe(result);
      // Only a Connect that ends connected records an installation.
      const recorded = (await storedInstallations()).length;
      expect(recorded).toBe(['connected', 'already_connected', 'taken'].includes(result) ? 1 : 0);
    });
  });

  it('a second workspace cannot claim an installation another workspace holds', async () => {
    const dana = await harness.member('owner');
    const lee = await harness.member('owner');
    reachable = { 'dana-code': [sprocketOrg], 'lee-code': [sprocketOrg] };

    expect((await connect(dana.headers, 41, 'dana-code')).result).toBe('connected');
    expect((await connect(lee.headers, 41, 'lee-code')).result).toBe('taken');

    const forLee = await get('/api/connections', lee.headers);
    expect(forLee.body.github.installations).toEqual([]);
    const forDana = await get('/api/connections', dana.headers);
    expect(forDana.body.github.installations).toHaveLength(1);
  });

  it('refuses an installation GitHub does not list for the person, whatever the address says', async () => {
    const dana = await harness.member('owner');
    reachable = { 'dana-code': [{ id: 52, login: 'dana', type: 'User' }] };

    expect((await connect(dana.headers, 41, 'dana-code')).result).toBe('not_installer');
    expect(await storedInstallations()).toEqual([]);
  });

  it("refuses an organisation's installation to a member of it who does not own it", async () => {
    // Mallory can read one of sprocket's repositories, so GitHub lists its installation for her.
    const mallory = await harness.member('owner');
    reachable = { 'mallory-code': [sprocketOrg] };
    membersOnly = new Set(['mallory-code']);

    expect((await connect(mallory.headers, 41, 'mallory-code')).result).toBe('not_account_admin');
    expect(await storedInstallations()).toEqual([]);

    // So the company's own owner can still connect it.
    const dana = await harness.member('owner');
    reachable['dana-code'] = [sprocketOrg];
    expect((await connect(dana.headers, 41, 'dana-code')).result).toBe('connected');
  });

  it('refuses a Connect another person started, and never spends their code', async () => {
    const dana = await harness.member('owner');
    const mallory = await harness.member('owner');
    reachable = { 'mallory-code': [sprocketOrg] };

    // Mallory's own link, opened in Dana's browser, connects nothing to Dana's workspace.
    const state = await stateFor(mallory.headers);
    const back = await returnFromGitHub(dana.headers, {
      code: 'mallory-code',
      installation_id: '41',
      state,
    });
    expect(back.result).toBe('bad_state');
    expect(seen.filter((call) => call.url.includes('oauth/access_token'))).toEqual([]);
    expect(await storedInstallations()).toEqual([]);
  });

  it('refuses a Connect the same person started in another session, and never spends the code', async () => {
    const dana = await harness.member('owner');
    reachable = { 'dana-code': [sprocketOrg] };
    // Dana signs in again elsewhere (another browser), into the same workspace.
    const context = (await harness.auth.$context) as unknown as {
      test: { login(input: { userId: string }): Promise<{ headers: Headers }> };
    };
    const elsewhere = (await context.test.login({ userId: dana.personId })).headers;

    // The link Dana's first session made, finished in her other one, connects nothing.
    const state = await stateFor(dana.headers);
    const back = await returnFromGitHub(elsewhere, {
      code: 'dana-code',
      installation_id: '41',
      state,
    });
    expect(back.result).toBe('bad_state');
    expect(seen.filter((call) => call.url.includes('oauth/access_token'))).toEqual([]);
    expect(await storedInstallations()).toEqual([]);

    // In the session that made it, the same state connects.
    const again = await returnFromGitHub(dana.headers, {
      code: 'dana-code',
      installation_id: '41',
      state,
    });
    expect(again.result).toBe('connected');
  });

  it('records the installation for the workspace the Connect was for, whatever is active by then', async () => {
    const dana = await harness.member('owner');
    reachable = { 'dana-code': [sprocketOrg] };
    const state = await stateFor(dana.headers);
    // Dana makes another workspace, which her session then has active.
    const other = await harness.app.request('/api/workspaces', {
      method: 'POST',
      headers: dana.headers,
      body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
    });
    expect(other.status).toBe(201);

    const back = await returnFromGitHub(dana.headers, {
      code: 'dana-code',
      installation_id: '41',
      state,
    });
    expect(back.result).toBe('connected');
    expect(await storedInstallations()).toEqual([
      expect.objectContaining({ installationId: 41, workspaceId: dana.workspaceId }),
    ]);
  });

  it('a member sees what is connected, and can neither connect nor disconnect', async () => {
    const dana = await harness.member('owner');
    reachable = { 'dana-code': [sprocketOrg] };
    await connect(dana.headers, 41, 'dana-code');

    const lee = await harness.member('member', { workspace: dana.workspaceId });
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
    expect(await storedInstallations()).toHaveLength(1);
  });

  it('an admin may connect and disconnect, as an owner may', async () => {
    const owner = await harness.member('owner');
    const admin = await harness.member('admin', { workspace: owner.workspaceId });
    reachable = { 'admin-code': [sprocketOrg] };
    expect((await connect(admin.headers, 41, 'admin-code')).result).toBe('connected');
    expect((await get('/api/connections', admin.headers)).body.canManage).toBe(true);
    expect((await disconnect('41', admin.headers)).status).toBe(204);
  });

  it('a role changed in member counts at the very next request, and so does leaving', async () => {
    const dana = await harness.member('owner');
    expect((await startConnect(dana.headers)).status).toBe(200);

    await harness.setRole(dana.personId, dana.workspaceId, 'member');
    expect(await startConnect(dana.headers)).toMatchObject({
      status: 403,
      body: { error: 'not_allowed' },
    });
    expect((await get('/api/connections', dana.headers)).body.canManage).toBe(false);

    await harness.removeMember(dana.personId, dana.workspaceId);
    expect(await get('/api/connections', dana.headers)).toEqual({
      status: 403,
      body: { error: 'not_a_member' },
    });
    expect(await startConnect(dana.headers)).toMatchObject({
      status: 403,
      body: { error: 'not_a_member' },
    });
  });

  it('disconnecting removes the record, and leaves the app installed on GitHub', async () => {
    const dana = await harness.member('owner');
    reachable = { 'dana-code': [sprocketOrg] };
    await connect(dana.headers, 41, 'dana-code');
    seen = [];

    expect((await disconnect('41', dana.headers)).status).toBe(204);
    expect(await storedInstallations()).toEqual([]);
    expect((await get('/api/connections', dana.headers)).body.github.installations).toEqual([]);
    expect(seen.filter((call) => call.url.includes('installations/41'))).toEqual([]);
    expect(seen.filter((call) => call.method === 'DELETE')).toEqual([]);

    expect(await disconnect('41', dana.headers)).toEqual({
      status: 404,
      body: { error: 'installation_not_found' },
    });
    expect(await disconnect('41x', dana.headers)).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
  });

  it("never disconnects another workspace's installation", async () => {
    const dana = await harness.member('owner');
    const lee = await harness.member('owner');
    reachable = { 'dana-code': [sprocketOrg] };
    await connect(dana.headers, 41, 'dana-code');

    expect(await disconnect('41', lee.headers)).toEqual({
      status: 404,
      body: { error: 'installation_not_found' },
    });
    expect(await storedInstallations()).toHaveLength(1);
  });

  it('starting and disconnecting are refused from anywhere but the web app', async () => {
    const dana = await harness.member('owner');
    reachable = { 'dana-code': [sprocketOrg] };
    await connect(dana.headers, 41, 'dana-code');
    for (const origin of ['http://localhost:6006', null]) {
      const elsewhere = new Headers(dana.headers);
      if (origin === null) elsewhere.delete('origin');
      else elsewhere.set('origin', origin);

      const started = await harness.app.request('/api/connections/github/install', {
        method: 'POST',
        headers: elsewhere,
      });
      expect(await answerOf('POST', '/api/connections/github/install', started)).toEqual({
        status: 403,
        body: { error: 'bad_origin' },
      });
      expect(await disconnect('41', elsewhere)).toEqual({
        status: 403,
        body: { error: 'bad_origin' },
      });
    }
    expect(await storedInstallations()).toHaveLength(1);
  });

  it('needs the workspace the page shows, and the one the session has active', async () => {
    const dana = await harness.member('owner');
    reachable = { 'dana-code': [sprocketOrg] };
    await connect(dana.headers, 41, 'dana-code');

    const unnamed = new Headers(dana.headers);
    unnamed.delete('x-consola-workspace');
    expect(await get('/api/connections', unnamed)).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
    // Another tab switched the session to another workspace: the page's request is refused,
    // and changes nothing.
    const switched = await harness.app.request('/api/workspaces', {
      method: 'POST',
      headers: dana.headers,
      body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
    });
    expect(switched.status).toBe(201);
    expect(await get('/api/connections', dana.headers)).toEqual({
      status: 409,
      body: { error: 'workspace_switched' },
    });
    expect(await disconnect('41', dana.headers)).toEqual({
      status: 409,
      body: { error: 'workspace_switched' },
    });
    expect(await storedInstallations()).toHaveLength(1);
  });

  it('needs an active workspace', async () => {
    const dana = await harness.signIn('dana@sprocket.test', 'Dana Ortiz');
    const headers = new Headers({
      cookie: dana.cookie,
      origin: harness.config.publicUrl,
      'x-consola-workspace': 'sprocket',
    });
    expect(await get('/api/connections', headers)).toEqual({
      status: 409,
      body: { error: 'no_active_workspace' },
    });
    expect(await startConnect(headers)).toMatchObject({
      status: 409,
      body: { error: 'no_active_workspace' },
    });
  });

  it('without the GitHub App configured, nothing can be connected', async () => {
    await restart({});
    const dana = await harness.member('owner');

    expect(await get('/api/connections', dana.headers)).toEqual({
      status: 200,
      body: { canManage: true, github: { configured: false, installations: [] } },
    });
    expect(await startConnect(dana.headers)).toMatchObject({
      status: 503,
      body: { error: 'github_not_configured' },
    });
    expect((await returnFromGitHub(dana.headers, { code: 'x' })).result).toBe('not_configured');
  });

  it('a key file that is not there stops the service from being built', async () => {
    const failure = await startApi({
      environment: { ...withGitHubApp(), GITHUB_APP_PRIVATE_KEY_PATH: join(keyFolder, 'none.pem') },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).problems).toEqual([
      expect.stringMatching(/^GITHUB_APP_PRIVATE_KEY_PATH: cannot read .*none\.pem \(ENOENT\)$/),
    ]);
  });

  it("never logs the app's secrets, a person's code or a token", async () => {
    const log = logged();
    const dana = await harness.member('owner');
    reachable = { 'dana-code': [sprocketOrg] };
    await connect(dana.headers, 41, 'dana-code');
    await connect(dana.headers, 41, 'used-code');
    gitHubDown = true;
    await connect(dana.headers, 41, 'dana-code');
    await get('/api/connections', dana.headers);

    const lines = log();
    expect(lines).not.toBe('');
    for (const secret of [CLIENT_SECRET, 'dana-code', 'ghu_', 'ghs_', appKeyLine]) {
      expect(secret).not.toBe('');
      expect(lines).not.toContain(secret);
    }
  });
});

describe("GitHub's webhooks", () => {
  const DELIVERY_ID = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

  /** A payload GitHub sent, as the bytes on disk (`webhookFixtures/`). */
  const fixture = (name: string) =>
    readFileSync(
      new URL(`./company/adapters/github/webhookFixtures/${name}.json`, import.meta.url),
      'utf8',
    );

  const signatureOf = (body: string, secret = WEBHOOK_SECRET) =>
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  type Delivery = {
    event?: string;
    deliveryId?: string;
    /** The signature header: GitHub's over the body unless given; null sends none. */
    signature?: string | null;
    /** An Origin header, which GitHub never sends. */
    origin?: string;
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
    if (delivery.origin !== undefined) headers.set('origin', delivery.origin);
    const response = await harness.app.request('/api/github/webhooks', {
      method: 'POST',
      headers,
      body,
    });
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

  const storedEvents = () => harness.db.company.select().from(gitHubEvents);

  let sprocket: Member;
  let acme: Member;

  beforeEach(async () => {
    await start({ GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET });
    // Sprocket holds the `sprocket` organisation's installation, 41; Acme holds 52.
    sprocket = await harness.member('owner');
    acme = await harness.member('owner');
    await harness.db.company.insert(githubInstallation).values([
      {
        installationId: 41,
        workspaceId: sprocket.workspaceId,
        accountId: 9001,
        accountLogin: 'sprocket',
        accountType: 'Organization',
        connectedBy: sprocket.personId,
        connectedAt: new Date('2026-11-22T21:00:00Z'),
      },
      {
        installationId: 52,
        workspaceId: acme.workspaceId,
        accountId: 9002,
        accountLogin: 'acme',
        accountType: 'Organization',
        connectedBy: acme.personId,
        connectedAt: new Date('2026-11-22T21:00:00Z'),
      },
    ]);
  });

  it("records a pull request opened on Sprocket's repository for Sprocket", async () => {
    const log = logged();
    const body = fixture('pull_request.opened');

    expect(await deliver(body, { event: 'pull_request' })).toEqual({
      status: 201,
      body: { result: 'recorded' },
    });

    expect(await storedEvents()).toEqual([
      {
        workspaceId: sprocket.workspaceId,
        deliveryId: DELIVERY_ID,
        event: 'pull_request',
        installationId: 41,
        payload: expect.any(String),
        receivedAt: expect.any(Date),
      },
    ]);
    expect(JSON.parse((await storedEvents())[0]?.payload ?? '')).toEqual(JSON.parse(body));
    expect(log()).toContain(
      `Recorded GitHub delivery ${DELIVERY_ID} (pull_request) for workspace ${sprocket.workspaceId} (installation 41).`,
    );
  });

  it("records Acme's push for Acme, and for no one else", async () => {
    logged();
    expect(await deliver(fixture('push'), { event: 'push' })).toEqual({
      status: 201,
      body: { result: 'recorded' },
    });
    expect(await storedEvents()).toEqual([
      expect.objectContaining({ workspaceId: acme.workspaceId, event: 'push', installationId: 52 }),
    ]);
  });

  it('refuses the same delivery a second time as a duplicate, and records it once', async () => {
    const log = logged();
    const body = fixture('pull_request.opened');
    expect((await deliver(body, { event: 'pull_request' })).status).toBe(201);
    expect(await deliver(body, { event: 'pull_request' })).toEqual({
      status: 409,
      body: { error: 'duplicate_delivery' },
    });
    expect(log()).toContain(
      `Refused GitHub delivery ${DELIVERY_ID} (pull_request): workspace ${sprocket.workspaceId} (installation 41) had it already.`,
    );
    expect(await storedEvents()).toHaveLength(1);
    // The same event under a new delivery id is a new delivery.
    const again = await deliver(body, {
      event: 'pull_request',
      deliveryId: '8a2b6d10-cc78-11e3-81ab-4c9367dc0958',
    });
    expect(again.status).toBe(201);
    expect(await storedEvents()).toHaveLength(2);
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
  ])('refuses a delivery with %s, before reading anything else', async (_what, made) => {
    const log = logged();
    const { body, signature } = made();
    expect(await deliver(body, { event: 'pull_request', signature })).toEqual({
      status: 401,
      body: { error: 'bad_signature' },
    });
    expect(await storedEvents()).toEqual([]);
    expect(log()).toContain(
      "Refused a webhook delivery: it is not signed with the GitHub App's webhook secret.",
    );
    // An unchecked delivery's id is anyone's words, so it is not logged.
    expect(log()).not.toContain(DELIVERY_ID);
  });

  it('checks the signature before the headers: an unsigned delivery with none is still 401', async () => {
    logged();
    const response = await harness.app.request('/api/github/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not even json',
    });
    expect(await answerOf('POST', '/api/github/webhooks', response)).toEqual({
      status: 401,
      body: { error: 'bad_signature' },
    });
  });

  it('drops and logs an event through an installation no workspace holds', async () => {
    const log = logged();
    expect(await deliver(through('pull_request.opened', 63), { event: 'pull_request' })).toEqual({
      status: 422,
      body: { error: 'unknown_installation' },
    });
    expect(await storedEvents()).toEqual([]);
    expect(log()).toContain(
      `Dropped GitHub delivery ${DELIVERY_ID} (pull_request): no workspace holds installation 63.`,
    );
  });

  it('drops an event that came through no installation', async () => {
    logged();
    const { installation: _installation, ...payload } = JSON.parse(fixture('pull_request.opened'));
    expect(await deliver(JSON.stringify(payload), { event: 'pull_request' })).toEqual({
      status: 422,
      body: { error: 'no_installation' },
    });
    expect(await storedEvents()).toEqual([]);
  });

  it('drops an installation once its workspace disconnects it', async () => {
    logged();
    await harness.db.company
      .delete(githubInstallation)
      .where(eq(githubInstallation.installationId, 41));
    expect(await deliver(fixture('pull_request.opened'), { event: 'pull_request' })).toEqual({
      status: 422,
      body: { error: 'unknown_installation' },
    });
    expect(await storedEvents()).toEqual([]);
  });

  it("answers GitHub's ping, and records it for no workspace", async () => {
    logged();
    expect(await deliver(fixture('ping'), { event: 'ping' })).toEqual({
      status: 200,
      body: { result: 'pong' },
    });
    expect(await storedEvents()).toEqual([]);
  });

  it('refuses a signed delivery whose headers or body are not what GitHub sends', async () => {
    logged();
    // No `X-GitHub-Event`.
    expect(await deliver(fixture('pull_request.opened'))).toEqual({
      status: 400,
      body: { error: 'invalid_delivery' },
    });
    // No `X-GitHub-Delivery`.
    const body = fixture('pull_request.opened');
    const response = await harness.app.request('/api/github/webhooks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signatureOf(body),
      },
      body,
    });
    expect(await answerOf('POST', '/api/github/webhooks', response)).toEqual({
      status: 400,
      body: { error: 'invalid_delivery' },
    });
    for (const notAnObject of ['action=opened', '[]', '"opened"']) {
      expect(await deliver(notAnObject, { event: 'pull_request' })).toEqual({
        status: 400,
        body: { error: 'invalid_delivery' },
      });
    }
    expect(await storedEvents()).toEqual([]);
  });

  it('refuses a body over what GitHub sends before reading it', async () => {
    const log = logged();
    const body = `{"padding":"${'x'.repeat(GITHUB_PAYLOAD_MAX_BYTES)}"}`;
    expect(await deliver(body, { event: 'pull_request', signature: 'sha256=00' })).toEqual({
      status: 413,
      body: { error: 'too_large' },
    });
    expect(log()).toContain(
      `Refused a webhook delivery: its body is over ${GITHUB_PAYLOAD_MAX_BYTES} bytes.`,
    );
  });

  it('is outside the origin check: its authority is the signature, wherever it comes from', async () => {
    logged();
    expect(
      await deliver(fixture('pull_request.opened'), {
        event: 'pull_request',
        origin: 'http://localhost:9999',
      }),
    ).toEqual({ status: 201, body: { result: 'recorded' } });
    // Its path alone: one under it is guarded like any other.
    const under = await harness.app.request('/api/github/webhooks/again', {
      method: 'POST',
      headers: { origin: 'http://localhost:9999', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(under.status).toBe(403);
    expect(await under.json()).toEqual({ error: 'bad_origin' });
  });

  it('without a webhook secret, refuses every delivery', async () => {
    await restart({});
    const log = logged();
    expect(await deliver(fixture('pull_request.opened'), { event: 'pull_request' })).toEqual({
      status: 503,
      body: { error: 'webhooks_not_configured' },
    });
    expect(log()).toContain('Refused a webhook delivery: GITHUB_WEBHOOK_SECRET is not set.');
  });

  it("answers 503 while the database does not answer, and GitHub's Redeliver gets the event in", async () => {
    const log = logged();
    const body = fixture('pull_request.opened');
    // The events table is out of reach: the delivery is checked, and cannot be recorded.
    await harness.db.company.execute(sql`alter table github_event rename to github_event_away`);
    expect(await deliver(body, { event: 'pull_request' })).toEqual({
      status: 503,
      body: { error: 'unavailable' },
    });
    expect(log()).toContain(
      `Could not record GitHub delivery ${DELIVERY_ID} (pull_request): the database did not answer`,
    );

    // GitHub's Redeliver sends the same delivery, with the same id, once the database is back.
    await harness.db.company.execute(sql`alter table github_event_away rename to github_event`);
    expect(await deliver(body, { event: 'pull_request' })).toEqual({
      status: 201,
      body: { result: 'recorded' },
    });
    expect(await storedEvents()).toHaveLength(1);
  });

  it('answers 503 unavailable when the database is closed', async () => {
    logged();
    await closeDatabase();
    expect(await deliver(fixture('pull_request.opened'), { event: 'pull_request' })).toEqual({
      status: 503,
      body: { error: 'unavailable' },
    });
  });

  it('never logs the secret, a signature or what an event says', async () => {
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
    expect(lines).toContain('Recorded GitHub delivery');
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

describe('GitHub tokens for a workspace', () => {
  /** What each installation covers on GitHub: Acme's 41, Bolt's 42 and Sprocket's 52. */
  const COVERED: Record<number, Array<{ id: number; full_name: string }>> = {
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

  /** A read of a repository by id with `token`, as a runner would make it on GitHub. */
  async function readRepository(token: string, id: number) {
    const response = await fetch(`https://api.github.com/repositories/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return response.status;
  }

  let workspaceIds: { acme: string; bolt: string; sprocket: string };
  /** `mintGitHubToken` on the stores and the GitHub App the composition builds. */
  let mint: (ask?: Partial<GitHubTokenRequest>) => ReturnType<typeof mintGitHubToken>;

  /** The use case's ports, from the harness's database and configuration, as `compose.ts` makes them. */
  async function mintingPorts() {
    const { mints } = createGitHubStores(harness.db.company);
    const settings = harness.config.github;
    const github = settings
      ? createGitHubApp({
          config: settings,
          privateKey: await loadGitHubAppKey(settings.privateKeyPath),
        })
      : null;
    return { mints, github, clock: systemClock };
  }

  async function holdInstallations() {
    const acmeOwner = await harness.member('owner');
    const sprocketOwner = await harness.member('owner');
    const boltOwner = await harness.member('owner');
    workspaceIds = {
      acme: acmeOwner.workspaceId,
      bolt: boltOwner.workspaceId,
      sprocket: sprocketOwner.workspaceId,
    };
    const holds = (installationId: number, owner: Member, login: string) => ({
      installationId,
      workspaceId: owner.workspaceId,
      accountId: installationId + 9000,
      accountLogin: login,
      accountType: 'Organization',
      connectedBy: owner.personId,
      connectedAt: new Date(),
    });
    await harness.db.company
      .insert(githubInstallation)
      .values([
        holds(41, acmeOwner, 'acme'),
        holds(42, boltOwner, 'bolt'),
        holds(52, sprocketOwner, 'sprocket'),
      ]);
  }

  /** Mints with `environment`'s app: Acme's catalog portal, to pull, unless `ask` says otherwise. */
  async function useApp(environment: Record<string, string>) {
    await restart(environment);
    await holdInstallations();
    const ports = await mintingPorts();
    mint = (ask = {}) =>
      mintGitHubToken(ports, {
        workspaceId: workspaceIds.acme,
        installationId: 41,
        purpose: 'factory-pull',
        repositoryIds: [410],
        ...ask,
      });
  }

  beforeEach(async () => {
    await useApp(withGitHubApp());
    fakeGitHub();
  });

  const storedMints = () => harness.db.company.select().from(githubTokenMint);

  it('mints a token for one repository, which GitHub lets read that repository alone', async () => {
    const minted = await mint();
    expect(minted).toEqual({
      kind: 'minted',
      token: 'ghs_narrowed_1',
      expiresAt: Date.parse('2099-01-01T00:00:00Z') / 1000,
      repositories: [{ id: 410, fullName: 'acme/catalog-portal' }],
      permissions: { contents: 'read', metadata: 'read' },
    });
    expect(mintBodies).toEqual([{ repository_ids: [410], permissions: { contents: 'read' } }]);
    if (minted.kind !== 'minted') throw new Error(minted.kind);

    // As GitHub answers it: the repository it was minted for, and not the installation's other.
    expect(await readRepository(minted.token, 410)).toBe(200);
    expect(await readRepository(minted.token, 411)).toBe(404);
    expect(await readRepository(minted.token, 520)).toBe(404);

    const [record, ...more] = await storedMints();
    expect(more).toEqual([]);
    expect(record).toMatchObject({
      workspaceId: workspaceIds.acme,
      installationId: 41,
      purpose: 'factory-pull',
      repositoryIds: [410],
      permissions: { contents: 'read', metadata: 'read' },
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
    expect(JSON.stringify(record)).not.toContain('ghs_');
  });

  it('gives each purpose its own permissions, and records every mint', async () => {
    const save = await mint({ purpose: 'factory-save' });
    expect(save).toMatchObject({ permissions: { contents: 'write', metadata: 'read' } });
    const review = await mint({ purpose: 'review-run', repositoryIds: [411, 410] });
    expect(review).toMatchObject({
      permissions: { contents: 'read', pull_requests: 'write', metadata: 'read' },
      repositories: [
        { id: 410, fullName: 'acme/catalog-portal' },
        { id: 411, fullName: 'acme/api' },
      ],
    });
    const sprocket = await mint({
      workspaceId: workspaceIds.sprocket,
      installationId: 52,
      repositoryIds: [520],
    });
    expect(sprocket.kind).toBe('minted');
    expect(mintBodies).toEqual([
      { repository_ids: [410], permissions: { contents: 'write' } },
      { repository_ids: [410, 411], permissions: { contents: 'read', pull_requests: 'write' } },
      { repository_ids: [520], permissions: { contents: 'read' } },
    ]);
    expect((await storedMints()).map((row) => [row.purpose, row.workspaceId])).toEqual([
      ['factory-save', workspaceIds.acme],
      ['review-run', workspaceIds.acme],
      ['factory-pull', workspaceIds.sprocket],
    ]);
  });

  it("never gives one workspace a token for another workspace's installation", async () => {
    // Bolt's work names Acme's installation.
    expect(await mint({ workspaceId: workspaceIds.bolt, installationId: 41 })).toEqual({
      kind: 'installation-not-found',
    });
    // Acme's work names Bolt's installation and repository.
    expect(await mint({ installationId: 42, repositoryIds: [420] })).toEqual({
      kind: 'installation-not-found',
    });
    expect(mintBodies).toEqual([]);
    expect(await storedMints()).toEqual([]);
  });

  it("refuses a repository outside the workspace's installation, before anything is minted", async () => {
    expect(await mint({ purpose: 'review-run', repositoryIds: [410, 520] })).toEqual({
      kind: 'not-covered',
      repositoryIds: [520],
    });
    expect(mintBodies).toEqual([]);
    expect(await storedMints()).toEqual([]);
  });

  it('refuses repositories its purpose does not allow', async () => {
    expect(await mint({ purpose: 'factory-save', repositoryIds: [410, 411] })).toEqual({
      kind: 'invalid',
      problems: ['too-many-repositories'],
    });
    expect(await mint({ repositoryIds: [] })).toEqual({
      kind: 'invalid',
      problems: ['no-repositories'],
    });
    expect(mintBodies).toEqual([]);
    expect(await storedMints()).toEqual([]);
  });

  it('passes on what GitHub says of the installation and the scope', async () => {
    logged();
    mintAnswer = () => Response.json(RECORDED.notAccessible, { status: 422 });
    expect(await mint()).toEqual({ kind: 'refused' });
    mintAnswer = () => Response.json({ message: 'Not Found' }, { status: 404 });
    expect(await mint()).toEqual({ kind: 'installation-gone' });
    expect(await storedMints()).toEqual([]);
  });

  it('revokes a token GitHub did not narrow as asked, and hands out nothing', async () => {
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
    expect(await mint()).toEqual({ kind: 'not-as-asked' });
    expect(revoked).toEqual(['ghs_whole_installation']);
    expect(await storedMints()).toEqual([]);
  });

  it('mints nothing when this server has no GitHub App', async () => {
    await useApp({});
    expect(await mint()).toEqual({ kind: 'not-configured' });
    expect(mintBodies).toEqual([]);
  });

  it('never logs a token or a key', async () => {
    const log = logged();
    await mint();
    mintAnswer = () => Response.json(RECORDED.notAccessible, { status: 422 });
    await mint();
    mintAnswer = () =>
      Response.json({ token: 'ghs_wide', expires_at: '2099-01-01T00:00:00Z' }, { status: 201 });
    await mint();

    const lines = log();
    expect(lines).not.toBe('');
    for (const secret of ['ghs_', CLIENT_SECRET, appKeyLine]) {
      expect(secret).not.toBe('');
      expect(lines).not.toContain(secret);
    }
  });
});
