import type { HealthProbe, WorkspaceCopies } from '../../application/ports.js';
import type { Database } from './database.js';
import { createHealthProbe } from './healthProbe.js';
import { createWorkspaceCopies } from './workspaceCopies.js';

/** Every port the use cases need, on one Drizzle database. */
export function createDrizzleStores(db: Database): {
  health: HealthProbe;
  workspaceCopies: WorkspaceCopies;
} {
  return { health: createHealthProbe(db), workspaceCopies: createWorkspaceCopies(db) };
}
