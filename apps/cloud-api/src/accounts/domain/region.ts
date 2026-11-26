/**
 * The regions a workspace can be in come from the contract `cloud-global` shares with the cells,
 * so both read one list. Each region has a cell of its own; accounts stay global. A workspace's
 * region is picked when it is created, and nothing changes it afterwards.
 */
export { isRegion, REGIONS, type Region } from '../../shared/region.js';
