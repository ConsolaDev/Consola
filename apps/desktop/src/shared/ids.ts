/**
 * Random record ids.
 *
 * A module of its own rather than a workspace.ts helper because
 * workItemActions.ts mints ids for the default actions while workspace.ts
 * imports those defaults for the v7 migration — kept in workspace.ts, the two
 * files would import each other.
 */
export function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}
