import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../../config.js';
import type { GitHubAppConfig } from '../../../config.js';
import { createGitHubApp, loadGitHubAppKey } from './gitHubApp.js';

// A key made for this run only, never one written down.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const config: GitHubAppConfig = {
  clientId: 'Iv23liSprocketTest',
  clientSecret: 'sprocket-test-client-secret',
  slug: 'consola-dev',
  privateKeyPath: '/unused',
};

const NOW = Date.parse('2026-11-22T12:00:00Z');

type Call = { method: string; url: URL; headers: Headers; body: unknown };
type Route = (call: Call) => Response | Promise<Response>;

/**
 * GitHub, as far as the app talks to it: each route answers `METHOD path`, and every call is
 * kept for the test to read. A call no route answers fails the test.
 */
function fakeGitHub(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call = { method: init.method ?? 'GET', url, headers: new Headers(init.headers), body };
    calls.push(call);
    const route = routes[`${call.method} ${url.origin}${url.pathname}`];
    if (!route) throw new Error(`The test made an unexpected request: ${call.method} ${url}`);
    return route(call);
  };
  return { fetch, calls };
}

function appFor(github: ReturnType<typeof fakeGitHub>, now = () => NOW) {
  const logged: string[] = [];
  const app = createGitHubApp({
    config,
    privateKey,
    fetch: github.fetch,
    now,
    log: (line) => logged.push(line),
  });
  return { app, logged };
}

/** The claims of an app token, once its RS256 signature checks against the app's public key. */
function appTokenClaims(authorization: string | null) {
  const token = authorization?.replace(/^Bearer /, '') ?? '';
  const [header = '', payload = '', signature = ''] = token.split('.');
  const signed = verify(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, 'base64url'),
  );
  expect(signed).toBe(true);
  expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
    alg: 'RS256',
    typ: 'JWT',
  });
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

const installation = (id: number, login: string, type = 'Organization') => ({
  id,
  account: { id: id + 1, login, type, avatar_url: 'https://avatars.test/x' },
  repository_selection: 'selected',
  permissions: { metadata: 'read' },
});

const repository = (id: number, fullName: string) => ({
  id,
  full_name: fullName,
  private: true,
  html_url: `https://github.com/${fullName}`,
  owner: { login: fullName.split('/')[0] },
});

const tokenExchange: Route = ({ body }) =>
  (body as { code: string }).code === 'good-code'
    ? Response.json({ access_token: 'ghu_person', token_type: 'bearer' })
    : Response.json({ error: 'bad_verification_code', error_description: 'bad' });

const revoked: Route = () => new Response(null, { status: 204 });

describe('the install address', () => {
  it("is the app's own install page, carrying the state", () => {
    const { app } = appFor(fakeGitHub({}));
    expect(app.installUrl('abc.def+/=')).toBe(
      'https://github.com/apps/consola-dev/installations/new?state=abc.def%2B%2F%3D',
    );
  });
});

describe('the sign-in address', () => {
  it("is GitHub's authorization for the app's client, carrying the state, and nothing secret", () => {
    const { app } = appFor(fakeGitHub({}));
    const url = new URL(app.signInUrl('abc.def+/='));
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect([...url.searchParams]).toEqual([
      ['client_id', 'Iv23liSprocketTest'],
      ['state', 'abc.def+/='],
    ]);
    expect(url.toString()).not.toContain(config.clientSecret);
  });
});

describe('what GitHub says of the person who came back', () => {
  const REVOKE = 'DELETE https://api.github.com/applications/Iv23liSprocketTest/token';
  const MEMBERSHIP = 'GET https://api.github.com/user/memberships/orgs/sprocket';

  /** A person, GitHub user 7, who can reach `installations`, with `membership` of sprocket. */
  function personGitHub(
    overrides: Record<string, Route> = {},
    installations: unknown[] = [installation(41, 'sprocket'), installation(6, 'dana', 'User')],
    membership: Route = () => Response.json({ state: 'active', role: 'admin' }),
  ) {
    return fakeGitHub({
      'POST https://github.com/login/oauth/access_token': tokenExchange,
      'GET https://api.github.com/user': () => Response.json({ id: 7, login: 'dana' }),
      'GET https://api.github.com/user/installations': () =>
        Response.json({ total_count: installations.length, installations }),
      [MEMBERSHIP]: membership,
      [REVOKE]: revoked,
      ...overrides,
    });
  }

  it('exchanges the code, reads the person, the installation and their membership, then revokes the token', async () => {
    const github = personGitHub();
    const { app, logged } = appFor(github);

    expect(await app.installerFacts('good-code', 41)).toEqual({
      kind: 'read',
      facts: {
        installation: {
          id: 41,
          account: { id: 42, login: 'sprocket', type: 'Organization' },
          repositorySelection: 'selected',
        },
        gitHubUserId: 7,
        organizationRole: 'admin',
      },
    });

    const [exchange, me, list, membership, revoke] = github.calls;
    expect(exchange?.body).toEqual({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: 'good-code',
    });
    expect(exchange?.headers.get('accept')).toBe('application/json');
    for (const call of [me, list, membership]) {
      expect(call?.headers.get('authorization')).toBe('Bearer ghu_person');
      expect(call?.headers.get('x-github-api-version')).toBe('2022-11-28');
    }
    expect(list?.url.searchParams.get('per_page')).toBe('100');
    expect(`${membership?.method} ${membership?.url}`).toBe(MEMBERSHIP);
    expect(revoke?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
    );
    expect(revoke?.body).toEqual({ access_token: 'ghu_person' });
    expect(logged).toEqual([]);
  });

  it('says a member is a member, and a pending or missing membership is none', async () => {
    const roleFor = async (membership: Route) => {
      const answer = await appFor(personGitHub({}, undefined, membership)).app.installerFacts(
        'good-code',
        41,
      );
      return answer.kind === 'read' ? answer.facts.organizationRole : answer.kind;
    };
    expect(await roleFor(() => Response.json({ state: 'active', role: 'member' }))).toBe('member');
    expect(await roleFor(() => Response.json({ state: 'active', role: 'billing_manager' }))).toBe(
      'member',
    );
    expect(await roleFor(() => Response.json({ state: 'pending', role: 'admin' }))).toBeNull();
    expect(
      await roleFor(() => Response.json({ message: 'Not Found' }, { status: 404 })),
    ).toBeNull();
  });

  it('is unavailable, naming the missing permission, when GitHub will not say who owns the organisation', async () => {
    const { app, logged } = appFor(
      personGitHub({}, undefined, () => Response.json({ message: 'no' }, { status: 403 })),
    );
    expect(await app.installerFacts('good-code', 41)).toEqual({ kind: 'unavailable' });
    expect(logged).toEqual([
      "GitHub refused reading the person's membership of sprocket (HTTP 403). The app needs the Members organization permission (read) to tell an organisation's owners from its members.",
    ]);
  });

  it("asks no membership for a person's own installation", async () => {
    const github = personGitHub({
      [MEMBERSHIP]: () => {
        throw new Error('asked');
      },
    });
    const answer = await appFor(github).app.installerFacts('good-code', 6);
    expect(answer).toEqual({
      kind: 'read',
      facts: {
        installation: {
          id: 6,
          account: { id: 7, login: 'dana', type: 'User' },
          repositorySelection: 'selected',
        },
        gitHubUserId: 7,
        organizationRole: null,
      },
    });
  });

  it('says so when the installation is not among those the person can reach', async () => {
    const github = personGitHub();
    expect(await appFor(github).app.installerFacts('good-code', 99)).toEqual({
      kind: 'read',
      facts: { installation: null, gitHubUserId: 7, organizationRole: null },
    });
    expect(github.calls.some((call) => call.url.pathname.includes('memberships'))).toBe(false);
  });

  it('reads every page', async () => {
    const all = Array.from({ length: 150 }, (_, n) => installation(1000 + n, `org-${n}`));
    const github = personGitHub({
      'GET https://api.github.com/user/installations': ({ url }) => {
        const page = Number(url.searchParams.get('page'));
        return Response.json({
          total_count: all.length,
          installations: all.slice((page - 1) * 100, page * 100),
        });
      },
      'GET https://api.github.com/user/memberships/orgs/org-149': () =>
        Response.json({ state: 'active', role: 'admin' }),
    });
    const answer = await appFor(github).app.installerFacts('good-code', 1149);
    expect(answer.kind === 'read' && answer.facts.installation?.account.login).toBe('org-149');
    expect(github.calls.filter((call) => call.url.pathname === '/user/installations')).toHaveLength(
      2,
    );
  });

  it('never takes an installation on an account that is neither an organisation nor a person', async () => {
    const github = personGitHub({}, [
      { ...installation(43, 'big-co'), account: { id: 7, slug: 'big-co', name: 'Big Co' } },
      { ...installation(44, 'bot'), account: null },
    ]);
    const { app } = appFor(github);
    for (const id of [43, 44]) {
      const answer = await app.installerFacts('good-code', id);
      expect(answer.kind === 'read' && answer.facts.installation).toBeNull();
    }
  });

  it('is code-refused for a code GitHub does not take, and asks nothing else', async () => {
    const github = personGitHub();
    expect(await appFor(github).app.installerFacts('used-code', 41)).toEqual({
      kind: 'code-refused',
    });
    expect(github.calls).toHaveLength(1);
  });

  it('is unavailable, and logs no secret, when the client secret is wrong', async () => {
    const github = personGitHub({
      'POST https://github.com/login/oauth/access_token': () =>
        Response.json({ error: 'incorrect_client_credentials' }),
    });
    const { app, logged } = appFor(github);
    expect(await app.installerFacts('good-code', 41)).toEqual({ kind: 'unavailable' });
    expect(logged).toEqual([
      "GitHub refused exchanging the callback's code: incorrect_client_credentials.",
    ]);
  });

  it('is unavailable when GitHub does not answer, and still revokes the token', async () => {
    const github = personGitHub({
      'GET https://api.github.com/user/installations': () => {
        throw new TypeError('fetch failed');
      },
    });
    const { app, logged } = appFor(github);
    expect(await app.installerFacts('good-code', 41)).toEqual({ kind: 'unavailable' });
    expect(github.calls.map((call) => call.method)).toEqual(['POST', 'GET', 'GET', 'DELETE']);
    expect(logged).toEqual(["GitHub did not answer listing a person's installations (TypeError)."]);
  });

  it('is unavailable when GitHub will not say who the person is', async () => {
    const github = personGitHub({
      'GET https://api.github.com/user': () => Response.json({ message: 'no' }, { status: 401 }),
    });
    const { app, logged } = appFor(github);
    expect(await app.installerFacts('good-code', 41)).toEqual({ kind: 'unavailable' });
    expect(logged).toEqual(['GitHub refused reading who the person is (HTTP 401).']);
  });

  it('is unavailable for an answer of a shape GitHub never gives', async () => {
    const github = personGitHub({
      'GET https://api.github.com/user/installations': () => Response.json({ installations: 'x' }),
    });
    expect(await appFor(github).app.installerFacts('good-code', 41)).toEqual({
      kind: 'unavailable',
    });
  });

  describe('once they signed in, with no installation named', () => {
    const ACME_MEMBERSHIP = 'GET https://api.github.com/user/memberships/orgs/acme';

    it('lists every installation they reach, with their membership of each organisation, then revokes the token', async () => {
      const github = personGitHub(
        { [ACME_MEMBERSHIP]: () => Response.json({ state: 'active', role: 'member' }) },
        [installation(41, 'sprocket'), installation(6, 'dana', 'User'), installation(52, 'acme')],
      );
      const { app, logged } = appFor(github);

      expect(await app.installationsOf('good-code')).toEqual({
        kind: 'read',
        installations: [
          {
            installation: {
              id: 41,
              account: { id: 42, login: 'sprocket', type: 'Organization' },
              repositorySelection: 'selected',
            },
            gitHubUserId: 7,
            organizationRole: 'admin',
          },
          {
            installation: {
              id: 6,
              account: { id: 7, login: 'dana', type: 'User' },
              repositorySelection: 'selected',
            },
            gitHubUserId: 7,
            organizationRole: null,
          },
          {
            installation: {
              id: 52,
              account: { id: 53, login: 'acme', type: 'Organization' },
              repositorySelection: 'selected',
            },
            gitHubUserId: 7,
            organizationRole: 'member',
          },
        ],
      });
      expect(
        github.calls.map((call) => `${call.method} ${call.url.origin}${call.url.pathname}`),
      ).toEqual([
        'POST https://github.com/login/oauth/access_token',
        'GET https://api.github.com/user',
        'GET https://api.github.com/user/installations',
        MEMBERSHIP,
        ACME_MEMBERSHIP,
        REVOKE,
      ]);
      expect(github.calls.at(-1)?.body).toEqual({ access_token: 'ghu_person' });
      expect(logged).toEqual([]);
    });

    it('is an empty list when they reach none, and still revokes the token', async () => {
      const github = personGitHub({}, []);
      expect(await appFor(github).app.installationsOf('good-code')).toEqual({
        kind: 'read',
        installations: [],
      });
      expect(github.calls.at(-1)?.method).toBe('DELETE');
    });

    it('leaves out an installation on an account that is neither an organisation nor a person', async () => {
      const github = personGitHub({}, [
        { ...installation(43, 'big-co'), account: { id: 7, slug: 'big-co', name: 'Big Co' } },
        installation(6, 'dana', 'User'),
      ]);
      const answer = await appFor(github).app.installationsOf('good-code');
      expect(
        answer.kind === 'read' && answer.installations.map((each) => each.installation?.id),
      ).toEqual([6]);
    });

    it('is code-refused for a code GitHub does not take, and asks nothing else', async () => {
      const github = personGitHub();
      expect(await appFor(github).app.installationsOf('used-code')).toEqual({
        kind: 'code-refused',
      });
      expect(github.calls).toHaveLength(1);
    });

    it('is unavailable, naming the missing permission, when GitHub will not say who owns an organisation, and still revokes the token', async () => {
      const github = personGitHub({}, undefined, () =>
        Response.json({ message: 'no' }, { status: 403 }),
      );
      const { app, logged } = appFor(github);
      expect(await app.installationsOf('good-code')).toEqual({ kind: 'unavailable' });
      expect(github.calls.at(-1)?.method).toBe('DELETE');
      expect(logged).toEqual([
        "GitHub refused reading the person's membership of sprocket (HTTP 403). The app needs the Members organization permission (read) to tell an organisation's owners from its members.",
      ]);
    });

    it('is unavailable when GitHub does not answer, and logs no code or token', async () => {
      const github = personGitHub({
        'GET https://api.github.com/user/installations': () => {
          throw new TypeError('fetch failed');
        },
      });
      const { app, logged } = appFor(github);
      expect(await app.installationsOf('good-code')).toEqual({ kind: 'unavailable' });
      expect(github.calls.map((call) => call.method)).toEqual(['POST', 'GET', 'GET', 'DELETE']);
      expect(logged).toEqual([
        "GitHub did not answer listing a person's installations (TypeError).",
      ]);
      expect(logged.join('\n')).not.toMatch(/good-code|ghu_person|sprocket-test-client-secret/);
    });
  });
});

describe("an installation's repositories", () => {
  function gitHubWith(repositories: Route, tokenStatus = 201) {
    let minted = 0;
    const github = fakeGitHub({
      'POST https://api.github.com/app/installations/41/access_tokens': () => {
        minted += 1;
        return tokenStatus === 201
          ? Response.json(
              { token: `ghs_installation_${minted}`, expires_at: '2026-11-22T13:00:00Z' },
              { status: 201 },
            )
          : Response.json({ message: 'no' }, { status: tokenStatus });
      },
      'GET https://api.github.com/installation/repositories': repositories,
    });
    return { github, minted: () => minted };
  }

  it('asks for a metadata-only token as the app, then lists them', async () => {
    const { github } = gitHubWith(() =>
      Response.json({
        total_count: 2,
        repositories: [repository(1, 'sprocket/catalog-portal'), repository(2, 'sprocket/api')],
      }),
    );
    const { app, logged } = appFor(github);

    expect(await app.repositoriesOf(41)).toEqual({
      kind: 'listed',
      repositories: [
        {
          id: 1,
          fullName: 'sprocket/catalog-portal',
          private: true,
          url: 'https://github.com/sprocket/catalog-portal',
        },
        { id: 2, fullName: 'sprocket/api', private: true, url: 'https://github.com/sprocket/api' },
      ],
    });

    const [mint, list] = github.calls;
    expect(mint?.body).toEqual({ permissions: { metadata: 'read' } });
    const seconds = NOW / 1000;
    expect(appTokenClaims(mint?.headers.get('authorization') ?? null)).toEqual({
      iat: seconds - 60,
      exp: seconds + 540,
      iss: config.clientId,
    });
    expect(list?.headers.get('authorization')).toBe('Bearer ghs_installation_1');
    expect(logged).toEqual([]);
  });

  it('keeps the token until five minutes before it expires', async () => {
    const { github, minted } = gitHubWith(() =>
      Response.json({ total_count: 0, repositories: [] }),
    );
    let now = NOW;
    const { app } = appFor(github, () => now);

    await app.repositoriesOf(41);
    now = Date.parse('2026-11-22T12:54:00Z');
    await app.repositoriesOf(41);
    expect(minted()).toBe(1);

    now = Date.parse('2026-11-22T12:55:00Z');
    await app.repositoriesOf(41);
    expect(minted()).toBe(2);
  });

  it('answers again from what it read for a minute, so a busy page spends little of the rate limit', async () => {
    let listed = 0;
    const { github } = gitHubWith(() => {
      listed += 1;
      return Response.json({ total_count: 0, repositories: [] });
    });
    let now = NOW;
    const { app } = appFor(github, () => now);

    await app.repositoriesOf(41);
    now += 59_999;
    await app.repositoriesOf(41);
    expect(listed).toBe(1);

    now += 1;
    await app.repositoriesOf(41);
    expect(listed).toBe(2);
  });

  it('drops a token GitHub stops taking', async () => {
    let refuse = true;
    const { github, minted } = gitHubWith(() =>
      refuse
        ? Response.json({ message: 'Bad credentials' }, { status: 401 })
        : Response.json({ total_count: 0, repositories: [] }),
    );
    const { app, logged } = appFor(github);

    expect(await app.repositoriesOf(41)).toEqual({ kind: 'unavailable' });
    expect(logged).toEqual(["GitHub refused listing installation 41's repositories (HTTP 401)."]);
    refuse = false;
    expect(await app.repositoriesOf(41)).toEqual({ kind: 'listed', repositories: [] });
    expect(minted()).toBe(2);
  });

  it('is gone for an installation GitHub no longer has, or has suspended', async () => {
    for (const status of [404, 403]) {
      const { github } = gitHubWith(() => Response.json({}), status);
      expect(await appFor(github).app.repositoriesOf(41)).toEqual({ kind: 'gone' });
    }
  });

  it('is unavailable when GitHub refuses the app itself', async () => {
    const { github } = gitHubWith(() => Response.json({}), 401);
    const { app, logged } = appFor(github);
    expect(await app.repositoriesOf(41)).toEqual({ kind: 'unavailable' });
    expect(logged).toEqual(['GitHub refused a token for installation 41 (HTTP 401).']);
  });

  it('never logs a token, the code or the client secret', async () => {
    const github = fakeGitHub({
      'POST https://github.com/login/oauth/access_token': tokenExchange,
      'GET https://api.github.com/user': () => Response.json({ id: 7 }),
      'GET https://api.github.com/user/installations': () =>
        Response.json({ message: 'no' }, { status: 500 }),
      'DELETE https://api.github.com/applications/Iv23liSprocketTest/token': () =>
        Response.json({ message: 'no' }, { status: 422 }),
      'POST https://api.github.com/app/installations/41/access_tokens': () =>
        Response.json({ token: 'ghs_secret_token', expires_at: 'never' }, { status: 201 }),
      'GET https://api.github.com/installation/repositories': () =>
        Response.json({ message: 'no' }, { status: 500 }),
    });
    const { app, logged } = appFor(github);
    await app.installerFacts('good-code', 41);
    await app.repositoriesOf(41);
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of ['ghu_person', 'ghs_secret_token', 'good-code', config.clientSecret]) {
      expect(logged.join('\n')).not.toContain(secret);
    }
  });
});

describe('minting a narrowed token', () => {
  const MINT = 'POST https://api.github.com/app/installations/41/access_tokens';
  const REVOKE = 'DELETE https://api.github.com/installation/token';
  const scope = { repositoryIds: [410], permissions: { contents: 'read' as const } };

  /** GitHub's answer to a mint, as it gives one for `repository_ids` (fixture names). */
  const minted = (overrides: Record<string, unknown> = {}) =>
    Response.json(
      {
        token: 'ghs_narrowed',
        expires_at: '2026-11-22T13:00:00Z',
        permissions: { contents: 'read', metadata: 'read' },
        repository_selection: 'selected',
        repositories: [repository(410, 'acme/catalog-portal')],
        ...overrides,
      },
      { status: 201 },
    );

  it('asks GitHub, as the app, for exactly these repositories and permissions', async () => {
    const github = fakeGitHub({ [MINT]: () => minted() });
    const { app, logged } = appFor(github);

    expect(await app.mintToken(41, scope)).toEqual({
      kind: 'minted',
      token: 'ghs_narrowed',
      expiresAt: new Date('2026-11-22T13:00:00Z'),
      repositories: [{ id: 410, fullName: 'acme/catalog-portal' }],
      permissions: { contents: 'read', metadata: 'read' },
    });
    const [mint] = github.calls;
    expect(mint?.body).toEqual({ repository_ids: [410], permissions: { contents: 'read' } });
    expect(appTokenClaims(mint?.headers.get('authorization') ?? null).iss).toBe(config.clientId);
    expect(logged).toEqual([]);
  });

  it('mints a new token every time: a narrowed token is never kept or reused', async () => {
    let count = 0;
    const github = fakeGitHub({
      [MINT]: () => {
        count += 1;
        return minted({ token: `ghs_narrowed_${count}` });
      },
    });
    const { app } = appFor(github);
    const first = await app.mintToken(41, scope);
    const second = await app.mintToken(41, scope);
    expect(first.kind === 'minted' && first.token).toBe('ghs_narrowed_1');
    expect(second.kind === 'minted' && second.token).toBe('ghs_narrowed_2');
  });

  it('never hands a narrowed token to the repositories list, which keeps its own', async () => {
    const github = fakeGitHub({
      [MINT]: ({ body }) =>
        (body as { repository_ids?: number[] }).repository_ids
          ? minted()
          : Response.json(
              { token: 'ghs_metadata', expires_at: '2026-11-22T13:00:00Z' },
              { status: 201 },
            ),
      'GET https://api.github.com/installation/repositories': () =>
        Response.json({ total_count: 0, repositories: [] }),
    });
    const { app } = appFor(github);
    await app.mintToken(41, scope);
    await app.repositoriesOf(41);
    const list = github.calls.find((call) => call.url.pathname === '/installation/repositories');
    expect(list?.headers.get('authorization')).toBe('Bearer ghs_metadata');
  });

  it('passes on what GitHub says the token carries, for the caller to check', async () => {
    const github = fakeGitHub({
      [MINT]: () =>
        minted({
          permissions: { contents: 'write', administration: 'write' },
          repositories: [repository(410, 'acme/catalog-portal'), repository(411, 'acme/api')],
        }),
    });
    const answer = await appFor(github).app.mintToken(41, scope);
    expect(answer).toMatchObject({
      kind: 'minted',
      repositories: [
        { id: 410, fullName: 'acme/catalog-portal' },
        { id: 411, fullName: 'acme/api' },
      ],
      permissions: { contents: 'write', administration: 'write' },
    });
  });

  it('takes an answer with no repositories or permissions as carrying none', async () => {
    const github = fakeGitHub({
      [MINT]: () =>
        Response.json({ token: 'ghs_whole', expires_at: '2026-11-22T13:00:00Z' }, { status: 201 }),
    });
    expect(await appFor(github).app.mintToken(41, scope)).toEqual({
      kind: 'minted',
      token: 'ghs_whole',
      expiresAt: new Date('2026-11-22T13:00:00Z'),
      repositories: [],
      permissions: {},
    });
  });

  it('is gone for an installation GitHub no longer has, or has suspended', async () => {
    for (const status of [404, 403]) {
      const github = fakeGitHub({ [MINT]: () => Response.json({}, { status }) });
      expect(await appFor(github).app.mintToken(41, scope)).toEqual({ kind: 'gone' });
    }
  });

  it('is refused when GitHub will not narrow a token to that scope', async () => {
    const github = fakeGitHub({
      [MINT]: () =>
        Response.json(
          { message: 'There is at least one repository that does not exist or is not accessible' },
          { status: 422 },
        ),
    });
    const { app, logged } = appFor(github);
    expect(await app.mintToken(41, scope)).toEqual({ kind: 'refused' });
    expect(logged).toEqual(['GitHub refused a narrowed token for installation 41 (HTTP 422).']);
  });

  it('is unavailable when GitHub refuses the app, or does not answer', async () => {
    const refusing = fakeGitHub({ [MINT]: () => Response.json({}, { status: 401 }) });
    expect(await appFor(refusing).app.mintToken(41, scope)).toEqual({ kind: 'unavailable' });

    const silent = fakeGitHub({
      [MINT]: () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    });
    expect(await appFor(silent).app.mintToken(41, scope)).toEqual({ kind: 'unavailable' });
  });

  it('revokes a token minted with an answer it cannot read, rather than leave it live', async () => {
    const github = fakeGitHub({
      [MINT]: () => minted({ expires_at: 'never' }),
      [REVOKE]: revoked,
    });
    const { app } = appFor(github);
    expect(await app.mintToken(41, scope)).toEqual({ kind: 'unavailable' });
    const revoke = github.calls.find((call) => call.method === 'DELETE');
    expect(revoke?.headers.get('authorization')).toBe('Bearer ghs_narrowed');
  });

  it('revokes a token with the token itself', async () => {
    const github = fakeGitHub({ [REVOKE]: revoked });
    const { app, logged } = appFor(github);
    await app.revokeToken('ghs_narrowed');
    expect(github.calls).toHaveLength(1);
    expect(github.calls[0]?.headers.get('authorization')).toBe('Bearer ghs_narrowed');
    expect(logged).toEqual([]);
  });

  it('never throws when a revoke fails, and logs no token', async () => {
    const refusing = fakeGitHub({ [REVOKE]: () => Response.json({}, { status: 401 }) });
    const first = appFor(refusing);
    await first.app.revokeToken('ghs_narrowed');
    expect(first.logged).toEqual(['GitHub did not revoke a narrowed token (HTTP 401).']);

    const silent = fakeGitHub({
      [REVOKE]: () => {
        throw new TypeError('fetch failed');
      },
    });
    const second = appFor(silent);
    await second.app.revokeToken('ghs_narrowed');
    for (const line of [...first.logged, ...second.logged]) {
      expect(line).not.toContain('ghs_narrowed');
    }
  });
});

describe("the app's private key", () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'consola-github-key-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('is read from the .pem GitHub downloads', async () => {
    const path = join(folder, 'app.pem');
    await writeFile(path, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    const key = await loadGitHubAppKey(path);
    expect(key.asymmetricKeyType).toBe('rsa');
  });

  it('a missing file is a configuration problem naming the setting', async () => {
    const path = join(folder, 'missing.pem');
    await expect(loadGitHubAppKey(path)).rejects.toThrow(ConfigError);
    await expect(loadGitHubAppKey(path)).rejects.toMatchObject({
      problems: [`GITHUB_APP_PRIVATE_KEY_PATH: cannot read ${path} (ENOENT)`],
    });
  });

  it('a file that is not an RSA private key is refused, and never quoted', async () => {
    const notRsa = generateKeyPairSync('ed25519').privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
    for (const [name, contents] of [
      ['public.pem', publicKey.export({ type: 'spki', format: 'pem' })],
      ['ed25519.pem', notRsa],
      ['notes.pem', 'sprocket-not-a-key'],
    ] as const) {
      const path = join(folder, name);
      await writeFile(path, contents);
      const failure = await loadGitHubAppKey(path).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ConfigError);
      const { problems } = failure as ConfigError;
      expect(problems).toEqual([
        `GITHUB_APP_PRIVATE_KEY_PATH: ${path} is not the app's private key (the .pem GitHub downloads, an RSA private key)`,
      ]);
      expect(problems.join('')).not.toContain('sprocket-not-a-key');
    }
  });
});
