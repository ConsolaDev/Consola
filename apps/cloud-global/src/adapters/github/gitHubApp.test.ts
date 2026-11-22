import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, type GitHubAppConfig } from '../../config.js';
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

describe("a person's installations", () => {
  it('exchanges the code, lists what the person can reach, then revokes the token', async () => {
    const github = fakeGitHub({
      'POST https://github.com/login/oauth/access_token': tokenExchange,
      'GET https://api.github.com/user/installations': () =>
        Response.json({
          total_count: 2,
          installations: [installation(41, 'sprocket'), installation(42, 'dana', 'User')],
        }),
      'DELETE https://api.github.com/applications/Iv23liSprocketTest/token': revoked,
    });
    const { app, logged } = appFor(github);

    expect(await app.installationsOfInstaller('good-code')).toEqual({
      kind: 'listed',
      installations: [
        {
          id: 41,
          account: { id: 42, login: 'sprocket', type: 'Organization' },
          repositorySelection: 'selected',
        },
        {
          id: 42,
          account: { id: 43, login: 'dana', type: 'User' },
          repositorySelection: 'selected',
        },
      ],
    });

    const [exchange, list, revoke] = github.calls;
    expect(exchange?.body).toEqual({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: 'good-code',
    });
    expect(exchange?.headers.get('accept')).toBe('application/json');
    expect(list?.headers.get('authorization')).toBe('Bearer ghu_person');
    expect(list?.headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(list?.url.searchParams.get('per_page')).toBe('100');
    expect(revoke?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
    );
    expect(revoke?.body).toEqual({ access_token: 'ghu_person' });
    expect(logged).toEqual([]);
  });

  it('reads every page', async () => {
    const all = Array.from({ length: 150 }, (_, n) => installation(1000 + n, `org-${n}`));
    const github = fakeGitHub({
      'POST https://github.com/login/oauth/access_token': tokenExchange,
      'GET https://api.github.com/user/installations': ({ url }) => {
        const page = Number(url.searchParams.get('page'));
        return Response.json({
          total_count: all.length,
          installations: all.slice((page - 1) * 100, page * 100),
        });
      },
      'DELETE https://api.github.com/applications/Iv23liSprocketTest/token': revoked,
    });
    const answer = await appFor(github).app.installationsOfInstaller('good-code');
    expect(answer.kind === 'listed' && answer.installations.map((each) => each.id)).toEqual(
      all.map((each) => each.id),
    );
  });

  it('leaves out an installation on an account that is neither an organisation nor a person', async () => {
    const github = fakeGitHub({
      'POST https://github.com/login/oauth/access_token': tokenExchange,
      'GET https://api.github.com/user/installations': () =>
        Response.json({
          total_count: 3,
          installations: [
            installation(41, 'sprocket'),
            { ...installation(43, 'big-co'), account: { id: 7, slug: 'big-co', name: 'Big Co' } },
            { ...installation(44, 'bot'), account: null },
          ],
        }),
      'DELETE https://api.github.com/applications/Iv23liSprocketTest/token': revoked,
    });
    const answer = await appFor(github).app.installationsOfInstaller('good-code');
    expect(answer.kind === 'listed' && answer.installations.map((each) => each.id)).toEqual([41]);
  });

  it('is code-refused for a code GitHub does not take, and asks nothing else', async () => {
    const github = fakeGitHub({
      'POST https://github.com/login/oauth/access_token': tokenExchange,
    });
    expect(await appFor(github).app.installationsOfInstaller('used-code')).toEqual({
      kind: 'code-refused',
    });
    expect(github.calls).toHaveLength(1);
  });

  it('is unavailable, and logs no secret, when the client secret is wrong', async () => {
    const github = fakeGitHub({
      'POST https://github.com/login/oauth/access_token': () =>
        Response.json({ error: 'incorrect_client_credentials' }),
    });
    const { app, logged } = appFor(github);
    expect(await app.installationsOfInstaller('good-code')).toEqual({ kind: 'unavailable' });
    expect(logged).toEqual([
      "GitHub refused exchanging the callback's code: incorrect_client_credentials.",
    ]);
  });

  it('is unavailable when GitHub does not answer, and still revokes the token', async () => {
    const github = fakeGitHub({
      'POST https://github.com/login/oauth/access_token': tokenExchange,
      'GET https://api.github.com/user/installations': () => {
        throw new TypeError('fetch failed');
      },
      'DELETE https://api.github.com/applications/Iv23liSprocketTest/token': revoked,
    });
    const { app, logged } = appFor(github);
    expect(await app.installationsOfInstaller('good-code')).toEqual({ kind: 'unavailable' });
    expect(github.calls.map((call) => call.method)).toEqual(['POST', 'GET', 'DELETE']);
    expect(logged).toEqual(["GitHub did not answer listing a person's installations (TypeError)."]);
  });

  it('is unavailable for an answer of a shape GitHub never gives', async () => {
    const github = fakeGitHub({
      'POST https://github.com/login/oauth/access_token': tokenExchange,
      'GET https://api.github.com/user/installations': () => Response.json({ installations: 'x' }),
      'DELETE https://api.github.com/applications/Iv23liSprocketTest/token': revoked,
    });
    expect(await appFor(github).app.installationsOfInstaller('good-code')).toEqual({
      kind: 'unavailable',
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
    now = Date.parse('2026-11-22T12:54:59Z');
    await app.repositoriesOf(41);
    expect(minted()).toBe(1);

    now = Date.parse('2026-11-22T12:55:00Z');
    await app.repositoriesOf(41);
    expect(minted()).toBe(2);
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
    await app.installationsOfInstaller('good-code');
    await app.repositoriesOf(41);
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of ['ghu_person', 'ghs_secret_token', 'good-code', config.clientSecret]) {
      expect(logged.join('\n')).not.toContain(secret);
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
