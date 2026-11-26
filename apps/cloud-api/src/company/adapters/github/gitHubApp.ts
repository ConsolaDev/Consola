import { createPrivateKey, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { GitHubApp, GitHubTokenMinter, MintAnswer } from '../../application/ports.js';
import type {
  GitHubInstallation,
  GitHubRepository,
  InstallerFacts,
} from '../../domain/connections.js';
import { ConfigError } from '../../config.js';
import type { GitHubAppConfig } from '../../config.js';

const WEB = 'https://github.com';
const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
/** How long any one call to GitHub may take. */
const TIMEOUT_MS = 10_000;
/** GitHub's largest page. */
const PER_PAGE = 100;
/** Past this many pages a list is cut short, rather than read forever. */
const MAX_PAGES = 10;
/** An installation token is reused until this long before it expires. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;
/**
 * How long an installation's repositories, once read, are the answer: so a page reloaded in a
 * loop spends one list a minute of the installation's rate limit, not one a reload.
 */
const REPOSITORIES_FRESH_MS = 60 * 1000;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Reads the app's private key, the `.pem` GitHub downloads, and checks it is an RSA private key.
 * A file that cannot be read, or holds something else, is a `ConfigError` naming the setting and
 * the path, never the file's contents.
 */
export async function loadGitHubAppKey(path: string): Promise<KeyObject> {
  let pem: string;
  try {
    pem = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unreadable';
    throw new ConfigError([`GITHUB_APP_PRIVATE_KEY_PATH: cannot read ${path} (${code})`]);
  }
  let key: KeyObject | null;
  try {
    key = createPrivateKey(pem);
  } catch {
    key = null;
  }
  if (key?.asymmetricKeyType !== 'rsa') {
    throw new ConfigError([
      `GITHUB_APP_PRIVATE_KEY_PATH: ${path} is not the app's private key (the .pem GitHub downloads, an RSA private key)`,
    ]);
  }
  return key;
}

const ACCOUNT = z.object({
  id: z.number().int(),
  login: z.string(),
  type: z.string(),
});

const INSTALLATIONS_PAGE = z.object({
  total_count: z.number().int(),
  installations: z.array(
    z.object({
      id: z.number().int(),
      // An enterprise's installation has an account of another shape, or none.
      account: z.unknown(),
      repository_selection: z.enum(['all', 'selected']),
    }),
  ),
});

const REPOSITORIES_PAGE = z.object({
  total_count: z.number().int(),
  repositories: z.array(
    z.object({
      id: z.number().int(),
      full_name: z.string(),
      private: z.boolean(),
      html_url: z.string(),
    }),
  ),
});

const USER_TOKEN = z.union([
  z.object({ access_token: z.string().min(1) }),
  z.object({ error: z.string() }),
]);

const PERSON = z.object({ id: z.number().int() });

const MEMBERSHIP = z.object({ state: z.string(), role: z.string() });

const INSTALLATION_TOKEN = z.object({ token: z.string().min(1), expires_at: z.string() });

/**
 * GitHub's answer to a narrowed mint. The repositories and permissions are what GitHub says the
 * token carries, read for the caller to check against what it asked: one missing reads as none,
 * so a token GitHub did not narrow is never taken for one it did.
 */
const NARROWED_TOKEN = z.object({
  token: z.string().min(1),
  expires_at: z.string(),
  permissions: z.record(z.string(), z.string()).optional(),
  repositories: z.array(z.object({ id: z.number().int(), full_name: z.string() })).optional(),
});

/** A call GitHub did not answer as it says it does. */
class Unanswered extends Error {}

/** A call GitHub refused: what it was, and GitHub's status. */
class Refused extends Error {
  constructor(
    readonly what: string,
    readonly status: number,
  ) {
    super(`HTTP ${status}`);
  }
}

/**
 * Consola's GitHub App over GitHub's REST API, with `fetch`. It signs its own app token (an
 * RS256 JWT whose issuer is the client ID) for each call that needs one. A person's token, from
 * the callback's code, is used for one list and then revoked. Installation tokens, asked only
 * for metadata read, are kept in memory until five minutes before they expire. A token minted
 * for a caller (`mintToken`), narrowed to its repositories and permissions, is a new one each
 * time, never kept, and never the one the repositories are listed with. No token, code or
 * secret is ever logged: a failure logs the call and GitHub's status.
 */
export function createGitHubApp(deps: {
  config: GitHubAppConfig;
  privateKey: KeyObject;
  fetch?: Fetch;
  now?: () => number;
  log?: (line: string) => void;
}): GitHubApp & GitHubTokenMinter {
  const { config, privateKey } = deps;
  const call: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.error(line));
  const installationTokens = new Map<number, { token: string; expiresAt: number }>();
  const repositoriesRead = new Map<number, { repositories: GitHubRepository[]; at: number }>();

  function appToken(): string {
    const seconds = Math.floor(now() / 1000);
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    // Issued a minute early, for clock drift; GitHub takes at most ten minutes.
    const input = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
      iat: seconds - 60,
      exp: seconds + 9 * 60,
      iss: config.clientId,
    })}`;
    return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
  }

  async function request(
    what: string,
    url: string,
    init: { method?: string; token?: string; basic?: string; body?: unknown },
  ): Promise<Response> {
    // Compared by origin, never by prefix: `https://api.github.com.example` starts with it too.
    const toApi = new URL(url).origin === API;
    const headers: Record<string, string> = {
      accept: toApi ? 'application/vnd.github+json' : 'application/json',
      'user-agent': 'Consola Cloud',
    };
    if (toApi) headers['x-github-api-version'] = API_VERSION;
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.basic) headers.authorization = `Basic ${init.basic}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await call(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'error';
      log(`GitHub did not answer ${what} (${reason}).`);
      throw new Unanswered();
    }
  }

  async function jsonOf<T>(what: string, response: Response, shape: z.ZodType<T>): Promise<T> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const parsed = shape.safeParse(body);
    if (!parsed.success) {
      log(`GitHub answered ${what} with a body Consola does not know (HTTP ${response.status}).`);
      throw new Unanswered();
    }
    return parsed.data;
  }

  /** Every page of a list, until GitHub's count is reached or a page comes back short. */
  async function allPages<T>(
    what: string,
    pageUrl: (page: number) => string,
    token: string,
    read: (response: Response) => Promise<{ total: number; items: T[] }>,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await request(what, pageUrl(page), { token });
      if (!response.ok) throw new Refused(what, response.status);
      const { total, items: more } = await read(response);
      items.push(...more);
      if (items.length >= total || more.length < PER_PAGE) return items;
    }
    log(`GitHub's answer to ${what} was cut at ${MAX_PAGES} pages.`);
    return items;
  }

  const asInstallation = (
    raw: z.infer<typeof INSTALLATIONS_PAGE>['installations'][number],
  ): GitHubInstallation | null => {
    const account = ACCOUNT.safeParse(raw.account);
    if (!account.success) return null;
    const { id, login, type } = account.data;
    if (type !== 'Organization' && type !== 'User') return null;
    return {
      id: raw.id,
      account: { id, login, type },
      repositorySelection: raw.repository_selection,
    };
  };

  async function revoke(userToken: string) {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    try {
      const response = await request(
        "revoking a person's token",
        `${API}/applications/${encodeURIComponent(config.clientId)}/token`,
        { method: 'DELETE', basic, body: { access_token: userToken } },
      );
      if (response.status !== 204) {
        log(`GitHub did not revoke a person's token (HTTP ${response.status}).`);
      }
    } catch {
      // Logged by `request`; the token expires on its own.
    }
  }

  async function installationToken(installationId: number): Promise<string | 'gone'> {
    const kept = installationTokens.get(installationId);
    if (kept && kept.expiresAt - TOKEN_MARGIN_MS > now()) return kept.token;
    installationTokens.delete(installationId);

    const what = `a token for installation ${installationId}`;
    const response = await request(
      what,
      `${API}/app/installations/${installationId}/access_tokens`,
      { method: 'POST', token: appToken(), body: { permissions: { metadata: 'read' } } },
    );
    // Uninstalled is 404; suspended is 403.
    if (response.status === 404 || response.status === 403) return 'gone';
    if (response.status !== 201) {
      log(`GitHub refused ${what} (HTTP ${response.status}).`);
      throw new Unanswered();
    }
    const { token, expires_at } = await jsonOf(what, response, INSTALLATION_TOKEN);
    const expiresAt = Date.parse(expires_at);
    if (Number.isFinite(expiresAt)) installationTokens.set(installationId, { token, expiresAt });
    return token;
  }

  /** Revokes an installation token with the token itself. It never throws. */
  async function revokeInstallationToken(token: string) {
    try {
      const response = await request('revoking a narrowed token', `${API}/installation/token`, {
        method: 'DELETE',
        token,
      });
      if (response.status !== 204) {
        log(`GitHub did not revoke a narrowed token (HTTP ${response.status}).`);
      }
    } catch {
      // Logged by `request`; the token expires on its own within the hour.
    }
  }

  async function mintToken(
    installationId: number,
    scope: Parameters<GitHubTokenMinter['mintToken']>[1],
  ): Promise<MintAnswer> {
    const what = `a narrowed token for installation ${installationId}`;
    let response: Response;
    try {
      response = await request(what, `${API}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        token: appToken(),
        body: { repository_ids: scope.repositoryIds, permissions: scope.permissions },
      });
    } catch (error) {
      if (error instanceof Unanswered) return { kind: 'unavailable' };
      throw error;
    }
    // Uninstalled is 404; suspended is 403.
    if (response.status === 404 || response.status === 403) return { kind: 'gone' };
    // A repository the installation does not cover, or a permission it was not granted.
    if (response.status === 422) {
      log(`GitHub refused ${what} (HTTP 422).`);
      return { kind: 'refused' };
    }
    if (response.status !== 201) {
      log(`GitHub refused ${what} (HTTP ${response.status}).`);
      return { kind: 'unavailable' };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const parsed = NARROWED_TOKEN.safeParse(body);
    if (!parsed.success) {
      log(`GitHub answered ${what} with a body Consola does not know (HTTP 201).`);
      // A token in an answer that does not read is never left live.
      const token = (body as { token?: unknown } | undefined)?.token;
      if (typeof token === 'string' && token !== '') await revokeInstallationToken(token);
      return { kind: 'unavailable' };
    }
    const { token, expires_at, permissions, repositories } = parsed.data;
    const expiresAt = Date.parse(expires_at);
    if (!Number.isFinite(expiresAt)) {
      log(`GitHub answered ${what} with no time it expires.`);
      await revokeInstallationToken(token);
      return { kind: 'unavailable' };
    }
    return {
      kind: 'minted',
      token,
      expiresAt: new Date(expiresAt),
      repositories: (repositories ?? []).map(({ id, full_name }) => ({ id, fullName: full_name })),
      permissions: permissions ?? {},
    };
  }

  return {
    mintToken,
    revokeToken: revokeInstallationToken,

    installUrl(state) {
      return `${WEB}/apps/${config.slug}/installations/new?state=${encodeURIComponent(state)}`;
    },

    async installerFacts(code, installationId) {
      let userToken: string;
      try {
        const what = "exchanging the callback's code";
        const response = await request(what, `${WEB}/login/oauth/access_token`, {
          method: 'POST',
          body: { client_id: config.clientId, client_secret: config.clientSecret, code },
        });
        if (!response.ok) {
          log(`GitHub refused ${what} (HTTP ${response.status}).`);
          return { kind: 'unavailable' };
        }
        const answer = await jsonOf(what, response, USER_TOKEN);
        if ('error' in answer) {
          if (answer.error === 'bad_verification_code') return { kind: 'code-refused' };
          log(`GitHub refused ${what}: ${answer.error.slice(0, 64)}.`);
          return { kind: 'unavailable' };
        }
        userToken = answer.access_token;
      } catch (error) {
        if (error instanceof Unanswered) return { kind: 'unavailable' };
        throw error;
      }

      try {
        const who = 'reading who the person is';
        const me = await request(who, `${API}/user`, { token: userToken });
        if (!me.ok) throw new Refused(who, me.status);
        const { id: gitHubUserId } = await jsonOf(who, me, PERSON);

        const listing = "listing a person's installations";
        const raw = await allPages(
          listing,
          (page) => `${API}/user/installations?per_page=${PER_PAGE}&page=${page}`,
          userToken,
          async (response) => {
            const body = await jsonOf(listing, response, INSTALLATIONS_PAGE);
            return { total: body.total_count, items: body.installations };
          },
        );
        const installation =
          raw.map(asInstallation).find((each) => each?.id === installationId) ?? null;

        let organizationRole: InstallerFacts['organizationRole'] = null;
        if (installation?.account.type === 'Organization') {
          const { login } = installation.account;
          const what = `reading the person's membership of ${login}`;
          const response = await request(
            what,
            `${API}/user/memberships/orgs/${encodeURIComponent(login)}`,
            { token: userToken },
          );
          // Not a member (or not yet one) is 404; anything else unanswered says nothing.
          if (response.status !== 404) {
            if (!response.ok) {
              log(
                `GitHub refused ${what} (HTTP ${response.status}). The app needs the Members organization permission (read) to tell an organisation's owners from its members.`,
              );
              return { kind: 'unavailable' };
            }
            const membership = await jsonOf(what, response, MEMBERSHIP);
            if (membership.state === 'active') {
              organizationRole = membership.role === 'admin' ? 'admin' : 'member';
            }
          }
        }
        return { kind: 'read', facts: { installation, gitHubUserId, organizationRole } };
      } catch (error) {
        if (error instanceof Refused) {
          log(`GitHub refused ${error.what} (HTTP ${error.status}).`);
          return { kind: 'unavailable' };
        }
        if (error instanceof Unanswered) return { kind: 'unavailable' };
        throw error;
      } finally {
        await revoke(userToken);
      }
    },

    async repositoriesOf(installationId) {
      const what = `listing installation ${installationId}'s repositories`;
      const read = repositoriesRead.get(installationId);
      if (read && now() - read.at < REPOSITORIES_FRESH_MS) {
        return { kind: 'listed', repositories: read.repositories };
      }
      repositoriesRead.delete(installationId);
      try {
        const token = await installationToken(installationId);
        if (token === 'gone') return { kind: 'gone' };
        const repositories = await allPages(
          what,
          (page) => `${API}/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
          token,
          async (response) => {
            const body = await jsonOf(what, response, REPOSITORIES_PAGE);
            return {
              total: body.total_count,
              items: body.repositories.map(
                (repository): GitHubRepository => ({
                  id: repository.id,
                  fullName: repository.full_name,
                  private: repository.private,
                  url: repository.html_url,
                }),
              ),
            };
          },
        );
        repositoriesRead.set(installationId, { repositories, at: now() });
        return { kind: 'listed', repositories };
      } catch (error) {
        if (error instanceof Refused) {
          // A token GitHub no longer takes is not kept for the next call.
          installationTokens.delete(installationId);
          log(`GitHub refused ${what} (HTTP ${error.status}).`);
          return { kind: 'unavailable' };
        }
        if (error instanceof Unanswered) return { kind: 'unavailable' };
        throw error;
      }
    },
  };
}
