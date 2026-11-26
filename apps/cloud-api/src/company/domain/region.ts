/**
 * The regions a workspace can be in, each served by a cell of its own. They come from the
 * contract the cell shares with `cloud-global`, so both read one list.
 */
export { isRegion, REGIONS, type Region } from '../../shared/region.js';
