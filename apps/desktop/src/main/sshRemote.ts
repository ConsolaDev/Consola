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
 * `resolve`, asked once per remote for the life of the run. `resolveSshRemote`
 * runs `ssh -G` synchronously, so a caller that resolves on every request
 * would block main's event loop each time. The cost: an ssh config edited
 * during a run is seen only after a restart.
 */
export function memoizeRemoteResolver(
  resolve: (remote: string) => string = resolveSshRemote,
): (remote: string) => string {
  const resolved = new Map<string, string>();
  return (remote) => {
    let answer = resolved.get(remote);
    if (answer === undefined) {
      answer = resolve(remote);
      resolved.set(remote, answer);
    }
    return answer;
  };
}
