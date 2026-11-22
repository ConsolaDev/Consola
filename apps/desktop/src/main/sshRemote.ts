import { execFile, execFileSync } from 'node:child_process';

/** `ssh -G` answers at once; one that hangs (a slow `Match exec`, say) is given up on. */
const SSH_CONFIG_TIMEOUT_MS = 2000;

/** The hostname line of `ssh -G`'s output, which prints the effective configuration without connecting. */
function hostnameIn(config: string): string | null {
  return config.match(/^hostname\s+(\S+)\s*$/im)?.[1] ?? null;
}

function sshHostname(host: string): string | null {
  try {
    const config = execFileSync('ssh', ['-G', host], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SSH_CONFIG_TIMEOUT_MS,
    });
    return hostnameIn(config);
  } catch {
    return null;
  }
}

/** `sshHostname`, run as a child main does not wait on. */
function lookUpSshHostname(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      'ssh',
      ['-G', host],
      { encoding: 'utf8', timeout: SSH_CONFIG_TIMEOUT_MS },
      (error, stdout) => resolve(error ? null : hostnameIn(stdout)),
    );
    // Nothing to read, as the synchronous lookup's ignored stdin.
    child.stdin?.end();
  });
}

/**
 * An ssh remote split around its host, or null for one that is not ssh or
 * whose host could be read as a command-line option.
 */
function splitSshRemote(remote: string): { host: string; withHost(name: string): string } | null {
  const match =
    remote.match(/^(ssh:\/\/(?:[^@/]+@)?)([^/:]+)(:\d+)?(\/.*)$/i) ??
    remote.match(/^((?:[^@\s/:]+@)?)([^:\s/]+)(:)(.+)$/);
  if (!match || (remote.includes('://') && !/^ssh:\/\//i.test(remote))) return null;
  const [, prefix, host, separator = '', repoPath] = match;
  // Never allow a remote's host to become a command-line option.
  if (!/^[a-z\d][a-z\d._-]*$/i.test(host)) return null;
  return { host, withHost: (name) => `${prefix}${name}${separator}${repoPath}` };
}

/** Expand SSH Host aliases without treating similarly named hosts as equivalent. */
export function resolveSshRemote(
  remote: string,
  resolveHost: (host: string) => string | null = sshHostname,
): string {
  const split = splitSshRemote(remote);
  const hostname = split && resolveHost(split.host);
  return split && hostname ? split.withHost(hostname) : remote;
}

/** `resolveSshRemote` without blocking main: the host is looked up by a child it awaits. */
export async function resolveSshRemoteAsync(
  remote: string,
  resolveHost: (host: string) => Promise<string | null> = lookUpSshHostname,
): Promise<string> {
  const split = splitSshRemote(remote);
  if (!split) return remote;
  const hostname = await resolveHost(split.host);
  return hostname ? split.withHost(hostname) : remote;
}

/**
 * `resolveSshRemoteAsync`, keeping for the life of the run the hostname each
 * host resolved to. A caller that resolves on every request (the branch
 * lookup reads origin on every find, before its cache) neither waits on
 * `ssh -G` each time nor blocks main while it runs. Requests that ask about
 * one host at once share one lookup. Only a hostname is kept: after a lookup
 * that failed or timed out, the next request asks again. The cost: an ssh
 * config edited during a run is seen only after a restart.
 */
export function memoizeRemoteResolver(
  resolveHost: (host: string) => Promise<string | null> = lookUpSshHostname,
): (remote: string) => Promise<string> {
  const hostnames = new Map<string, string>();
  const asking = new Map<string, Promise<string | null>>();
  const knownHost = (host: string): Promise<string | null> => {
    const known = hostnames.get(host);
    if (known !== undefined) return Promise.resolve(known);
    let lookup = asking.get(host);
    if (!lookup) {
      lookup = resolveHost(host)
        .catch(() => null)
        .then((hostname) => {
          asking.delete(host);
          if (hostname !== null) hostnames.set(host, hostname);
          return hostname;
        });
      asking.set(host, lookup);
    }
    return lookup;
  };
  return (remote) => resolveSshRemoteAsync(remote, knownHost);
}
