/**
 * Which session host addresses the app may call itself (a follow-up, `sendFollowUp`). The address
 * is the one the session's runner reported, which the protocol checks only as an origin
 * (`isHostUrl`: any `https:` host, or `http:` on loopback), and a runner is admitted by a shared
 * secret alone. A person's browser already connects there; the app calling it, with a pass, is new
 * reach, so it calls only an address its deployment expects:
 *
 * - `https:` on a host under one of `suffixes` (`SANDBOX_HOST_SUFFIXES`; E2B's exposed ports,
 *   `<port>-<sandbox>.e2b.app`, by default), on the default port, never an IP address;
 * - `http:` on `127.0.0.1`, `localhost` or `[::1]`, only when the runner's sandboxes run on this
 *   machine (`LOCAL_SANDBOXES`: tests and a local provider).
 *
 * It reads the address alone and resolves nothing. A name under an allowed suffix that resolves to
 * a private address is not caught: a known limit of the POC, which trusts the suffix's owner.
 */
export type HostAddressPolicy = {
  /** Host names a session's host may be under, lowercase, such as `e2b.app`. */
  readonly suffixes: readonly string[];
  /** Whether `http:` on loopback is a session's host: the runner's sandboxes run on this machine. */
  readonly local: boolean;
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Whether a host name is an IP address. A URL writes an IPv4 address dotted (whatever form it was
 * given in: `0x7f.1` is `127.0.0.1`), and an IPv6 address in brackets.
 */
const isIpAddress = (hostname: string): boolean =>
  hostname.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);

/** Whether the app may call the session host at `hostUrl` under `policy`. */
export function hostAddressAllowed(hostUrl: string, policy: HostAddressPolicy): boolean {
  let url: URL;
  try {
    url = new URL(hostUrl);
  } catch {
    return false;
  }
  // An origin and nothing else: no user info, path, query or fragment, as the protocol has it.
  if (url.origin !== hostUrl) return false;
  const host = url.hostname;
  if (url.protocol === 'http:') return policy.local && LOOPBACK.has(host);
  if (url.protocol !== 'https:' || url.port !== '') return false;
  if (isIpAddress(host) || host === 'localhost' || host.endsWith('.localhost')) return false;
  return policy.suffixes.some((suffix) => host.endsWith(`.${suffix}`));
}
