import { BlockList, isIP } from 'net';
import { promises as dns } from 'dns';
import { parseWorkItemAssetUrl, webImageUrl } from '../../shared/workItemAssets';
import type { InboxServiceDeps } from './InboxService';

export interface WorkItemAssetDeps extends Pick<InboxServiceDeps, 'getWorkspace' | 'resolveDriver'> {
  /**
   * Node's fetch, not Electron's net.fetch: every hop is followed by hand
   * with `redirect: 'manual'`, which needs the 3xx itself back, and net.fetch
   * rejects that with "Redirect was cancelled".
   */
  fetch: typeof fetch;
  /** Every address a hostname resolves to. Defaults to getaddrinfo. */
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Addresses no image in a work item may come from: this machine, the local
 * network, and the ranges that never route. An image is fetched because
 * someone else wrote its URL into a PR, so without this, opening a PR could
 * send requests to the reader's own services. GitHub's image proxy cannot
 * reach them either, so nothing GitHub itself would show is lost. IPv4 rules
 * also catch the IPv4-mapped IPv6 spellings of the same addresses.
 */
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) NON_PUBLIC.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

const systemLookup = (hostname: string) => dns.lookup(hostname, { all: true, verbatim: true });

/**
 * Whether every address `url` names is on the public internet. Checked before
 * each request, redirects included; a name that resolves to nothing fails.
 */
async function isPublicDestination(url: URL, lookup: NonNullable<WorkItemAssetDeps['lookup']>): Promise<boolean> {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host);
  return addresses.length > 0
    && addresses.every(({ address, family }) => !NON_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4'));
}

class Refusal extends Error {
  constructor(readonly status: number) {
    super(`refused with ${status}`);
  }
}

const refuse = (status: number) => new Response(null, { status });

/**
 * Serves one `consola-asset://` image request (see shared/workItemAssets).
 *
 * The workspace in the URL only picks which record to read; the account and
 * its token come from main's own copy of that workspace, as for item details.
 * The token rides on the first request to a URL the provider claims as a
 * private asset and on nothing else: the signed redirect it earns is
 * followed bare, so the credential is never sent to the storage host.
 *
 * Redirects are followed by hand so each hop is held to the same rules as the
 * first: a web URL, on a public address. Only images come back. Anything else
 * answers with an error status, which the renderer shows as a broken image
 * with its alt text.
 */
export async function fetchWorkItemAsset(deps: WorkItemAssetDeps, href: string): Promise<Response> {
  const asset = parseWorkItemAssetUrl(href);
  if (!asset) return refuse(400);
  const provider = deps.getWorkspace(asset.workspaceId)?.provider;
  if (!provider) return refuse(404);
  const lookup = deps.lookup ?? systemLookup;
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  try {
    const driver = deps.resolveDriver(provider.id);
    let headers: Record<string, string> | undefined = driver.isPrivateAsset?.(asset.url)
      ? { Authorization: `Bearer ${await driver.token(provider.accountLogin)}` }
      : undefined;
    let url = asset.url;
    let response: Response;
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) throw new Refusal(508);
      if (!(await isPublicDestination(url, lookup))) throw new Refusal(403);
      response = await deps.fetch(url, { headers, redirect: 'manual', signal });
      if (!REDIRECTS.has(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get('location');
      const next = location ? webImageUrl(new URL(location, url).href) : null;
      if (!next) throw new Refusal(502);
      url = next;
      headers = undefined;
    }

    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.startsWith('image/')) {
      await response.body?.cancel();
      return refuse(response.ok ? 415 : response.status);
    }
    return new Response(response.body, { status: 200, headers: { 'Content-Type': type } });
  } catch (error) {
    // A token gh would not lend, a private address, a timeout, a network
    // failure: all of them leave the same broken image, and none of them is
    // worth a dialog.
    return refuse(error instanceof Refusal ? error.status : 502);
  }
}

interface StoredAsset {
  type: string;
  bytes: Uint8Array;
}

/**
 * fetchWorkItemAsset, remembering what it served for as long as the app
 * runs. Avatars are why: the same person's picture sits on every comment,
 * event and commit they made, and a long pull request would otherwise ask
 * for it dozens of times. Requests for an image already on its way wait for
 * that one fetch.
 *
 * Only small images are kept, the newest few hundred of them, and never a
 * failure: an image that did not load is asked for again next time. Keyed by
 * the whole `consola-asset://` address, workspace included, so one account's
 * private upload is never served to another workspace.
 */
export function createWorkItemAssetCache(
  deps: WorkItemAssetDeps,
  { maxEntries = 300, maxBytes = 512 * 1024 }: { maxEntries?: number; maxBytes?: number } = {}
): (href: string) => Promise<Response> {
  const stored = new Map<string, Promise<StoredAsset | null>>();
  const serve = (entry: StoredAsset) =>
    new Response(entry.bytes.slice(), { status: 200, headers: { 'Content-Type': entry.type } });

  return async (href) => {
    const known = stored.get(href);
    if (known) {
      const entry = await known;
      if (entry) {
        // Most recently used goes last, so eviction takes the oldest.
        stored.delete(href);
        stored.set(href, known);
        return serve(entry);
      }
    }
    let settle!: (entry: StoredAsset | null) => void;
    const slot = new Promise<StoredAsset | null>((resolve) => { settle = resolve; });
    stored.set(href, slot);
    // Every way out but a stored image goes through here, so whoever waits
    // on this fetch is never left waiting, and the next request asks again.
    const forget = (response: Response) => {
      settle(null);
      if (stored.get(href) === slot) stored.delete(href);
      return response;
    };

    try {
      const response = await fetchWorkItemAsset(deps, href);
      if (!response.ok || !response.body) return forget(response);
      const type = response.headers.get('content-type') ?? '';
      // Read only as far as the limit. Past it the image is not kept: what
      // was read and the rest of the stream go straight to the page, so an
      // image of any size never sits in main's memory whole.
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
        if (size > maxBytes) return forget(new Response(resume(chunks, reader), { status: 200, headers: { 'Content-Type': type } }));
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const entry = { type, bytes };
      settle(entry);
      while (stored.size > maxEntries) stored.delete(stored.keys().next().value!);
      return serve(entry);
    } catch {
      // The body broke off: a timeout or a dropped connection. The same
      // broken image as any other failed fetch.
      return forget(refuse(502));
    }
  };
}

/** A stream of the chunks already read, then whatever `reader` has left. */
function resume(chunks: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks.splice(0)) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
