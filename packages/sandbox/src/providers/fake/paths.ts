/**
 * `path` as an absolute path with no `.`, `..` or repeated slashes, taking a relative one from
 * `base`. A `..` above the root stays at the root, as it does on Linux.
 */
export function resolvePath(base: string, path: string): string {
  const joined = path.startsWith('/') ? path : `${base}/${path}`;
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}
