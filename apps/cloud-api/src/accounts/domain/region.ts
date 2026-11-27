/**
 * The regions a workspace can be in, from the app's one list (`shared/`), so every part reads the
 * same. A workspace is in the region of the deployment that made it, and nothing changes it
 * afterwards.
 */
export { isRegion, REGIONS, type Region } from '../../shared/region.js';
