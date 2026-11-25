import createClient from 'openapi-fetch';
import type { GitHubTokenMint, GitHubTokenMinter } from '../../application/ports.js';
import type { paths } from './apiContract.js';

/** How long the cell waits for `cloud-global` to mint, which waits for GitHub in turn. */
export const MINT_TIMEOUT_MS = 15_000;

/** A token as the protocol carries one: printable ASCII, no space, at most 2048 characters. */
const TOKEN = /^[\x21-\x7e]{1,2048}$/;

/** The latest time a `Date` holds, in seconds: past it, `toISOString` throws. */
const LATEST_SECONDS = 8.64e12;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isGitHubId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** `cloud-global`'s 201, read as strictly as its contract: anything else is `unavailable`. */
function readMinted(body: unknown): GitHubTokenMint {
  const unavailable: GitHubTokenMint = { kind: 'unavailable' };
  if (!isRecord(body)) return unavailable;
  const { token, expiresAt, repositories, permissions } = body;
  if (typeof token !== 'string' || !TOKEN.test(token)) return unavailable;
  if (!isGitHubId(expiresAt) || expiresAt > LATEST_SECONDS) return unavailable;
  if (!Array.isArray(repositories) || !isRecord(permissions)) return unavailable;
  const named: { id: number; fullName: string }[] = [];
  for (const each of repositories) {
    if (!isRecord(each) || !isGitHubId(each.id) || typeof each.fullName !== 'string') {
      return unavailable;
    }
    named.push({ id: each.id, fullName: each.fullName });
  }
  const granted: Record<string, string> = {};
  for (const [name, level] of Object.entries(permissions)) {
    if (typeof level !== 'string') return unavailable;
    granted[name] = level;
  }
  return { kind: 'minted', token, expiresAt, repositories: named, permissions: granted };
}

/** A refusal by its status and code, as `cloud-global`'s contract declares them. */
function readRefusal(status: number, body: unknown): GitHubTokenMint {
  const code = isRecord(body) && typeof body.error === 'string' ? body.error : null;
  switch (status) {
    case 400:
      return code === 'invalid_token_request'
        ? { kind: 'refused', refusal: 'invalid-request' }
        : { kind: 'refused', refusal: 'unreadable' };
    case 401:
      return { kind: 'refused', refusal: 'unsigned' };
    case 403:
      if (code === 'other_region') return { kind: 'refused', refusal: 'other-region' };
      if (code === 'repository_not_covered') {
        return { kind: 'refused', refusal: 'repository-not-covered' };
      }
      if (code === 'scope_refused') return { kind: 'refused', refusal: 'scope-refused' };
      return { kind: 'unavailable' };
    case 404:
      return { kind: 'refused', refusal: 'installation-not-found' };
    case 410:
      return { kind: 'refused', refusal: 'installation-gone' };
    case 503:
      return code === 'github_not_configured'
        ? { kind: 'refused', refusal: 'github-not-configured' }
        : { kind: 'unavailable' };
    default:
      return { kind: 'unavailable' };
  }
}

/**
 * `cloud-global`'s `POST /api/github/tokens` (`postGitHubToken` in its contract), through an
 * `openapi-fetch` client typed by the types generated from its `openapi.json` (`apiContract.ts`),
 * at `baseUrl`, the cell's `CLOUD_GLOBAL_URL`. It follows no redirect, gives up after
 * `MINT_TIMEOUT_MS`, and reads every answer as the contract declares it, and nothing else: an
 * answer it does not know, a failed connection or a timeout is `unavailable`. It never throws,
 * and keeps nothing: the token is in the answer it returns, and in no error or log line.
 */
export function createGitHubTokenMinter(deps: {
  baseUrl: string;
  /** Only tests pass one: the machine's `fetch` otherwise. */
  fetch?: (request: Request) => Promise<Response>;
  timeoutMs?: number;
}): GitHubTokenMinter {
  const client = createClient<paths>({
    baseUrl: deps.baseUrl,
    fetch: deps.fetch ?? ((request) => fetch(request)),
    redirect: 'error',
  });
  const timeoutMs = deps.timeoutMs ?? MINT_TIMEOUT_MS;
  return {
    async mint(signedRequest) {
      try {
        const { data, error, response } = await client.POST('/api/github/tokens', {
          body: { request: signedRequest },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 201) return readMinted(data);
        return readRefusal(response.status, error);
      } catch {
        // A failed connection, a redirect, a timeout, or a body that is no JSON.
        return { kind: 'unavailable' };
      }
    },
  };
}
