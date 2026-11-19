import * as path from 'node:path';

/** Whether `child` is `parent` or lies below it. Both already resolved. */
export function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
