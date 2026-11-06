import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../shared/workspace';
import { workItemAssetUrl } from '../../shared/workItemAssets';
import { createStubDriver } from './stubDriver.test-helpers';
import { createWorkItemAssetCache, fetchWorkItemAsset } from './workItemAssets';

const PRIVATE = 'https://github.com/user-attachments/assets/0b6f1e7a-5d2c-4c1e-9a3b-2f8d7c6e5a4b';
const SIGNED = 'https://objects.example/0b6f1e7a.png?X-Amz-Signature=abc';
const BADGE = 'https://badges.example/age/npm/react/19.0.0?slim=true';

const image = (type = 'image/png') => new Response('png-bytes', { status: 200, headers: { 'content-type': type } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

/** Every name is public unless a test says where it points. */
function setup(fetchImpl: (url: URL, init?: RequestInit) => Promise<Response>, dns: Record<string, string[]> = {}) {
  const workspace = { provider: { id: 'github', accountLogin: 'workspace-account', org: 'sprocket' } } as Workspace;
  const driver = createStubDriver({
    token: vi.fn(async () => 'gho_workspace'),
    isPrivateAsset: (url: URL) => url.href === PRIVATE,
  });
  const fetch = vi.fn(fetchImpl);
  const lookup = vi.fn(async (hostname: string) =>
    (dns[hostname] ?? ['140.82.112.3']).map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  );
  const deps = {
    getWorkspace: (id: string) => (id === 'ws' ? workspace : undefined),
    resolveDriver: () => driver,
    fetch: fetch as unknown as typeof globalThis.fetch,
    lookup,
  };
  const load = (src: string, workspaceId = 'ws') => fetchWorkItemAsset(deps, workItemAssetUrl(workspaceId, src)!);
  return { driver, fetch, load };
}

const authorization = (init?: RequestInit) => new Headers(init?.headers).get('authorization');

describe('fetchWorkItemAsset', () => {
  it('fetches a private upload as the workspace account and follows the signed redirect without the token', async () => {
    const { driver, fetch, load } = setup(async (url) => (url.href === PRIVATE ? redirect(SIGNED) : image()));
    const response = await load(PRIVATE);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(await response.text()).toBe('png-bytes');
    expect(driver.token).toHaveBeenCalledWith('workspace-account');
    expect(fetch).toHaveBeenCalledTimes(2);
    const [[first, firstInit], [second, secondInit]] = fetch.mock.calls;
    expect(first.href).toBe(PRIVATE);
    expect(authorization(firstInit)).toBe('Bearer gho_workspace');
    expect(second.href).toBe(SIGNED);
    expect(authorization(secondInit)).toBeNull();
    expect(fetch.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
  });

  it('fetches every other image anonymously, without borrowing a token', async () => {
    const { driver, fetch, load } = setup(async () => image('image/svg+xml'));
    const response = await load(BADGE);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(driver.token).not.toHaveBeenCalled();
    expect(authorization(fetch.mock.calls[0][1])).toBeNull();
  });

  it('serves only images', async () => {
    const { load } = setup(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect((await load(BADGE)).status).toBe(415);
  });

  it('passes an upstream failure through as a broken image', async () => {
    const { load } = setup(async () => new Response('missing', { status: 404 }));
    expect((await load(BADGE)).status).toBe(404);
  });

  it('never requests this machine or the local network, by address or by name', async () => {
    const { fetch, load } = setup(async () => image(), {
      'printer.example': ['192.168.1.20'],
      'split.example': ['140.82.112.3', '10.0.0.7'],
      'v6.example': ['fd12::1'],
    });
    for (const src of [
      'http://127.0.0.1:8080/admin.png',
      'http://[::1]/a.png',
      'http://[::ffff:127.0.0.1]/a.png',
      'http://169.254.169.254/latest/meta-data',
      'http://localhost:3000/a.png',
      'http://app.localhost/a.png',
      'https://printer.example/a.png',
      'https://split.example/a.png',
      'https://v6.example/a.png',
    ]) {
      expect((await load(src)).status, src).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('holds every redirect hop to the same rules as the first request', async () => {
    const { fetch, load } = setup(async () => redirect('http://192.168.1.1/router.png'));
    expect((await load(BADGE)).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to anything but a web URL', async () => {
    const { load } = setup(async () => redirect('file:///etc/passwd'));
    expect((await load(BADGE)).status).toBe(502);
  });

  it('stops following redirects after a handful of hops', async () => {
    const { fetch, load } = setup(async (url) => redirect(`${url.origin}/next${Math.random()}`));
    expect((await load(BADGE)).status).toBe(508);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('turns a token gh will not lend into a broken image rather than a crash', async () => {
    const { driver, fetch, load } = setup(async () => image());
    vi.mocked(driver.token).mockRejectedValueOnce(new Error('gh could not authenticate workspace-account.'));
    expect((await load(PRIVATE)).status).toBe(502);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('serves nothing for a workspace it does not know, or a URL it did not produce', async () => {
    const { fetch, load } = setup(async () => image());
    expect((await load(BADGE, 'unknown')).status).toBe(404);
    const deps = { getWorkspace: () => undefined, resolveDriver: () => createStubDriver(), fetch: fetch as unknown as typeof globalThis.fetch };
    expect((await fetchWorkItemAsset(deps, 'consola-asset://image/?workspace=ws&url=file%3A%2F%2F%2Fetc%2Fpasswd')).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('createWorkItemAssetCache', () => {
  function cached(fetchImpl: (url: URL) => Promise<Response>, limits?: { maxEntries?: number; maxBytes?: number }) {
    const workspace = { provider: { id: 'github', accountLogin: 'workspace-account', org: 'sprocket' } } as Workspace;
    const fetch = vi.fn(fetchImpl);
    const fetchCached = createWorkItemAssetCache({
      getWorkspace: (id: string) => (id === 'ws' ? workspace : undefined),
      resolveDriver: () => createStubDriver({}),
      fetch: fetch as unknown as typeof globalThis.fetch,
      lookup: async () => [{ address: '140.82.112.3', family: 4 }],
    }, limits);
    return { fetch, load: (src: string, workspaceId = 'ws') => fetchCached(workItemAssetUrl(workspaceId, src)!) };
  }
  const AVATAR = 'https://avatars.example/u/1?s=40';

  it('fetches an image once however often, and however concurrently, it is asked for', async () => {
    const { fetch, load } = cached(async () => image());
    const responses = await Promise.all([load(AVATAR), load(AVATAR), load(AVATAR)]);
    const again = await load(AVATAR);
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const response of [...responses, again]) {
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(await response.text()).toBe('png-bytes');
    }
  });

  it('keeps each workspace’s copy apart', async () => {
    const { fetch, load } = cached(async () => image());
    await load(AVATAR, 'ws');
    expect((await load(AVATAR, 'other')).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('asks again for an image that failed, and does not keep a large one', async () => {
    let fail = true;
    const { fetch, load } = cached(async () => (fail ? new Response(null, { status: 500 }) : image()), { maxBytes: 4 });
    expect((await load(AVATAR)).status).toBe(500);
    fail = false;
    expect(await (await load(AVATAR)).text()).toBe('png-bytes');
    expect(await (await load(AVATAR)).text()).toBe('png-bytes');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('forgets the least recently used image past its limit', async () => {
    const { fetch, load } = cached(async () => image(), { maxEntries: 2 });
    await load('https://avatars.example/a');
    await load('https://avatars.example/b');
    await load('https://avatars.example/a');
    await load('https://avatars.example/c');
    await load('https://avatars.example/a');
    expect(fetch).toHaveBeenCalledTimes(3);
    await load('https://avatars.example/b');
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
