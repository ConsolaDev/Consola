import { execFileSync } from 'child_process';

function sshHostname(host: string): string | null {
  try {
    // -G prints the effective local configuration without connecting.
    const config = execFileSync('ssh', ['-G', host], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
    });
    return config.match(/^hostname\s+(\S+)\s*$/mi)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Expand SSH Host aliases without treating similarly named hosts as equivalent. */
export function resolveSshRemote(
  remote: string,
  resolveHost: (host: string) => string | null = sshHostname
): string {
  const match = remote.match(/^(ssh:\/\/(?:[^@/]+@)?)([^/:]+)(:\d+)?(\/.*)$/i)
    ?? remote.match(/^((?:[^@\s/:]+@)?)([^:\s/]+)(:)(.+)$/);
  if (!match || remote.includes('://') && !/^ssh:\/\//i.test(remote)) return remote;
  const [, prefix, host, separator = '', repoPath] = match;
  // Never allow a remote's host to become a command-line option.
  if (!/^[a-z\d][a-z\d._-]*$/i.test(host)) return remote;
  const hostname = resolveHost(host);
  return hostname ? `${prefix}${hostname}${separator}${repoPath}` : remote;
}
