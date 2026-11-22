/**
 * The regions a workspace can be in, each served by a cell of its own. `cloud-global` gives each
 * workspace one of the same list (issue 1.2), and keeps its own copy until the shared contract
 * package (issue 5.2) holds it once.
 */
export const REGIONS = ['eu', 'us'] as const;

export type Region = (typeof REGIONS)[number];

export function isRegion(value: unknown): value is Region {
  return typeof value === 'string' && (REGIONS as readonly string[]).includes(value);
}
