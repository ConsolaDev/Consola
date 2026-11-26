/**
 * The regions a workspace can be in, each served by a cell of its own; accounts stay global. A
 * workspace's region is picked when it is made, and nothing changes it afterwards. `cloud-global`
 * and every cell read this one list.
 */
export const REGIONS = ['eu', 'us'] as const;

export type Region = (typeof REGIONS)[number];

export function isRegion(value: unknown): value is Region {
  return typeof value === 'string' && (REGIONS as readonly string[]).includes(value);
}
