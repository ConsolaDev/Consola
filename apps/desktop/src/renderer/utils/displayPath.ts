/**
 * `path` with the home directory written as `~`.
 *
 * Inferred from the path's shape rather than asked of main: the renderer has
 * no `os.homedir()`, and every home directory Consola runs under is
 * `/Users/<name>` (macOS) or `/home/<name>` (Linux).
 */
export function tildePath(path: string): string {
  const match = /^\/(?:Users|home)\/[^/]+(?=\/|$)/.exec(path);
  return match ? `~${path.slice(match[0].length)}` : path;
}
