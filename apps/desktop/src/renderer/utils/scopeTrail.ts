import type { Scope } from '../../shared/workspace';
import { basename } from './fileUtils';

type ScopeLike = Pick<Scope, 'id' | 'name' | 'path'>;

/** A scope's display name, after the scope that contains it when it has one. */
export type ScopeTrail = { parent?: string; label: string };

/** Forward slashes, no trailing separator: comparable across platforms. */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * How the sidebar and the pane name a scope: on its own when it is a top-level folder,
 * or after the scope that contains it ("sprocket / apps/api") when it narrows
 * into one, so a glance tells root from subfolder even when the workspace and
 * its root scope share a name.
 *
 * The nearest containing scope wins. A folder named after its own directory
 * reads as its path from that scope; a name someone chose is kept as is.
 */
export function scopeTrail(scopes: readonly ScopeLike[], scope: ScopeLike): ScopeTrail {
  const path = normalize(scope.path);
  let container: { name: string; path: string } | undefined;
  for (const candidate of scopes) {
    if (candidate.id === scope.id) continue;
    const candidatePath = normalize(candidate.path);
    if (!path.startsWith(`${candidatePath}/`)) continue;
    if (!container || candidatePath.length > container.path.length) {
      container = { name: candidate.name, path: candidatePath };
    }
  }
  if (!container) return { label: scope.name };
  const relative = path.slice(container.path.length + 1);
  const named = scope.name !== basename(scope.path);
  return { parent: container.name, label: named ? scope.name : relative };
}
