/**
 * Random record ids.
 *
 * A module of its own rather than a workspace.ts helper because
 * workItemActions.ts mints ids for the default actions while workspace.ts
 * imports those defaults for the v7 migration — kept in workspace.ts, the two
 * files would import each other.
 */
export function generateId(): string {
  // 13 random base-36 characters from crypto.getRandomValues, never
  // Math.random, then the time, as before.
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const random = Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('');
  return random.slice(0, 13) + Date.now().toString(36);
}
