import { execFileSync } from 'node:child_process';

function sshHostname(host: string): string | null {
  try {
    // -G prints the effective local configuration without connecting.
    const config = execFileSync('ssh', ['-G', host], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
    });
    return config.match(/^hostname\s+(\S+)\s*$/im)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Expand SSH Host aliases without treating similarly named hosts as equivalent. */
export function resolveSshRemote(
  remote: string,
  resolveHost: (host: string) => string | null = sshHostname,
): string {
  const match =
    remote.match(/^(ssh:\/\/(?:[^@/]+@)?)([^/:]+)(:\d+)?(\/.*)$/i) ??
    remote.match(/^((?:[^@\s/:]+@)?)([^:\s/]+)(:)(.+)$/);
  if (!match || (remote.includes('://') && !/^ssh:\/\//i.test(remote))) return remote;
  const [, prefix, host, separator = '', repoPath] = match;
  // Never allow a remote's host to become a command-line option.
  if (!/^[a-z\d][a-z\d._-]*$/i.test(host)) return remote;
  const hostname = resolveHost(host);
  return hostname ? `${prefix}${hostname}${separator}${repoPath}` : remote;
}

/**
 * `resolveSshRemote`, keeping for the life of the run the hostname each host
 * resolved to. `ssh -G` runs synchronously, so a caller that resolves on every
 * request would block main's event loop each time. Only a hostname is kept: a
 * lookup that failed or timed out is asked again next time, so Retry can
 * recover an alias that failed once. The cost: an ssh config edited during a
 * run is seen only after a restart.
 */
export function memoizeRemoteResolver(
  resolveHost: (host: string) => string | null = sshHostname,
): (remote: string) => string {
  const hostnames = new Map<string, string>();
  const knownHost = (host: string): string | null => {
    const known = hostnames.get(host);
    if (known !== undefined) return known;
    const hostname = resolveHost(host);
    if (hostname !== null) hostnames.set(host, hostname);
    return hostname;
  };
  return (remote) => resolveSshRemote(remote, knownHost);
}
