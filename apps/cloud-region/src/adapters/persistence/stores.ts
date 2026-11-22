import type { HealthProbe } from '../../application/ports.js';
import type { Database } from './database.js';
import { createHealthProbe } from './healthProbe.js';

/** Every port the use cases need, on one Drizzle database. */
export function createDrizzleStores(db: Database): { health: HealthProbe } {
  return { health: createHealthProbe(db) };
}
