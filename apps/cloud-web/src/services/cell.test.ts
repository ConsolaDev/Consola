import { describe, expect, it } from 'vitest';
import { createApi } from './api';
import { cellBaseUrl, createCellSession } from './cell';

const grantFor = (workspaceId: string, minted: number) =>
  new Response(
    JSON.stringify({ token: `token-${minted}`, expiresAt: 1300, workspaceId, region: 'eu' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** A session whose `cloud-global` mints a token for `workspaceId`, only once `release` runs. */
function held(workspaceId: string) {
  let minted = 0;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cellUrls: string[] = [];
  const session = createCellSession({
    api: createApi({
      baseUrl: 'http://web.test',
      fetch: async () => {
        minted += 1;
        const mint = minted;
        await released;
        return grantFor(workspaceId, mint);
      },
    }),
    cellFetch: async (request) => {
      cellUrls.push(`${request.headers.get('authorization')} ${new URL(request.url).pathname}`);
      return new Response(JSON.stringify({ teams: [], canManage: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    cellOrigin: 'http://web.test',
    nowSeconds: () => 1000,
  });
  return { session, release, mints: () => minted, cellUrls };
}

describe('cellBaseUrl', () => {
  it("is the region's path on the page's origin", () => {
    expect(cellBaseUrl('eu')).toBe('/cell/eu');
    expect(cellBaseUrl('us', 'http://web.test')).toBe('http://web.test/cell/us');
  });
});

describe('a cell session', () => {
  it('mints one token for calls made at once', async () => {
    const { session, release, mints, cellUrls } = held('ws-acme');
    const calls = [
      session.onCell('ws-acme', (cell) => cell.GET('/api/teams')),
      session.onCell('ws-acme', (cell) => cell.GET('/api/factories')),
    ];
    release();
    await Promise.all(calls);
    expect(mints()).toBe(1);
    expect(cellUrls.sort()).toEqual([
      'Bearer token-1 /cell/eu/api/factories',
      'Bearer token-1 /cell/eu/api/teams',
    ]);
  });

  it('never lends a token minted for another workspace', async () => {
    const { session, release, cellUrls } = held('ws-acme');
    const calls = [
      session.onCell('ws-acme', (cell) => cell.GET('/api/teams')),
      session.onCell('ws-sprocket', (cell) => cell.GET('/api/teams')),
    ];
    release();
    const [acme, sprocket] = await Promise.all(calls);
    expect(acme && 'response' in acme && acme.response.status).toBe(200);
    expect(sprocket).toEqual({ kind: 'switched' });
    expect(cellUrls).toEqual(['Bearer token-1 /cell/eu/api/teams']);
  });
});
