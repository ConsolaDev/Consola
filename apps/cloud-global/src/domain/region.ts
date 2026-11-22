/**
 * The regions a workspace can be in. Each will have a cell of its own; accounts stay global. A
 * workspace's region is picked when it is created, and nothing changes it afterwards.
 */
export const REGIONS = ['eu', 'us'] as const;

export type Region = (typeof REGIONS)[number];

export function isRegion(value: unknown): value is Region {
  return typeof value === 'string' && (REGIONS as readonly string[]).includes(value);
}

/**
 * The region of the deployment's one organisation, and of every organisation made before
 * workspaces had a region.
 */
export const DEPLOYMENT_REGION: Region = 'eu';
