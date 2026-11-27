/**
 * The regions a workspace can be in. A deployment runs in one (`REGION`), and every workspace it
 * makes is made in it; nothing changes a workspace's region afterwards. Accounts and the
 * configuration read this one list.
 */
export const REGIONS = ['eu', 'us'] as const;

export type Region = (typeof REGIONS)[number];

export function isRegion(value: unknown): value is Region {
  return typeof value === 'string' && (REGIONS as readonly string[]).includes(value);
}
