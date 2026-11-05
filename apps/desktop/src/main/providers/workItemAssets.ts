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
