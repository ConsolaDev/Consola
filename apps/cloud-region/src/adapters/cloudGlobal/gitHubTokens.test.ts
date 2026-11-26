import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitHubTokenMinter } from './gitHubTokens.js';

/** A stand-in for an installation token, never a real one. */
const TOKEN = 'ghs_sprocketStandInToken0123456789abcdef';

const BASE = 'http://127.0.0.1:3100';

/** A `fetch` that answers every request with `status` and `body`, keeping what was asked. */
function answering(status: number, body: unknown, asked: Request[] = []) {
  return async (request: Request) => {
    asked.push(request);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const minted = {
  token: TOKEN,
  expiresAt: 1_800_003_600,
  repositories: [{ id: 410, fullName: 'sprocket/catalog-portal' }],
  permissions: { contents: 'read', pull_requests: 'write', metadata: 'read' },
};

let server: Server | null = null;

afterEach(async () => {
  const open = server;
  server = null;
  if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
});

describe("cloud-global's token minter", () => {
  it("posts the signed request to /api/github/tokens and reads the 201 as cloud-global's contract has it", async () => {
    const asked: Request[] = [];
    const minter = createGitHubTokenMinter({ baseUrl: BASE, fetch: answering(201, minted, asked) });
    expect(await minter.mint('signed.request.jws')).toEqual({ kind: 'minted', ...minted });
    expect(asked).toHaveLength(1);
    const [request] = asked;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(`${BASE}/api/github/tokens`);
    expect(await request?.json()).toEqual({ request: 'signed.request.jws' });
  });

  it.each([
    [400, { error: 'unreadable' }, 'unreadable'],
    [400, { error: 'invalid_request' }, 'unreadable'],
    [400, { error: 'invalid_token_request', problems: ['no-repositories'] }, 'invalid-request'],
    [401, { error: 'unsigned' }, 'unsigned'],
    [403, { error: 'other_region' }, 'other-region'],
    [403, { error: 'repository_not_covered', repositoryIds: [410] }, 'repository-not-covered'],
    [403, { error: 'scope_refused' }, 'scope-refused'],
    [404, { error: 'installation_not_found' }, 'installation-not-found'],
    [410, { error: 'installation_gone' }, 'installation-gone'],
    [503, { error: 'github_not_configured' }, 'github-not-configured'],
  ])('reads a %i %j as a refusal', async (status, body, refusal) => {
    const minter = createGitHubTokenMinter({ baseUrl: BASE, fetch: answering(status, body) });
    expect(await minter.mint('signed')).toEqual({ kind: 'refused', refusal });
  });

  it.each([
    ['GitHub not answering', 503, { error: 'github_unavailable' }],
    ['a failure of its own', 500, 'Internal Server Error'],
    ['a status the contract does not declare', 418, {}],
    ['a 201 with no token', 201, { ...minted, token: undefined }],
    ['a 201 whose token holds a space', 201, { ...minted, token: 'ghs_a b' }],
    ['a 201 with a time past what a date holds', 201, { ...minted, expiresAt: 9e15 }],
    ['a 201 whose repositories are no list', 201, { ...minted, repositories: 410 }],
    ['a 201 whose permissions are no strings', 201, { ...minted, permissions: { contents: 1 } }],
  ])('takes %s as unavailable', async (_case, status, body) => {
    const minter = createGitHubTokenMinter({ baseUrl: BASE, fetch: answering(status, body) });
    expect(await minter.mint('signed')).toEqual({ kind: 'unavailable' });
  });

  it('takes a failed connection and a body that is no JSON as unavailable, never throwing', async () => {
    const failing = createGitHubTokenMinter({
      baseUrl: BASE,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await failing.mint('signed')).toEqual({ kind: 'unavailable' });
    const html = createGitHubTokenMinter({
      baseUrl: BASE,
      fetch: async () =>
        new Response('<html>', { status: 201, headers: { 'content-type': 'application/json' } }),
    });
    expect(await html.mint('signed')).toEqual({ kind: 'unavailable' });
  });

  it('follows no redirect, and gives up on an answer that never comes', async () => {
    const seen: string[] = [];
    server = createServer((request, response) => {
      seen.push(request.url ?? '');
      if (request.url === '/api/github/tokens') {
        response.writeHead(307, { location: '/elsewhere' }).end();
      }
      // Anything else is never answered.
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const redirected = createGitHubTokenMinter({ baseUrl: `http://127.0.0.1:${port}` });
    expect(await redirected.mint('signed')).toEqual({ kind: 'unavailable' });
    expect(seen).toEqual(['/api/github/tokens']);

    const slow = createGitHubTokenMinter({
      baseUrl: `http://127.0.0.1:${port}/never`,
      timeoutMs: 50,
    });
    expect(await slow.mint('signed')).toEqual({ kind: 'unavailable' });
  });
});
