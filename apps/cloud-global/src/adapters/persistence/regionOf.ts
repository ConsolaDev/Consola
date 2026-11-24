import { isRegion } from '../../domain/region.js';
import type { Region } from '../../domain/region.js';

/**
 * A stored workspace's region, read back only when it is one of `REGIONS`. Any other value is a
 * row nothing here wrote, and it is an error rather than a guess.
 */
export function regionOf(row: { slug: string; region: string }): Region {
  if (!isRegion(row.region)) {
    throw new Error(`The workspace ${row.slug} is in an unknown region, "${row.region}".`);
  }
  return row.region;
}
