import type {
  CloudSessionStore,
  FactoryStore,
  HealthProbe,
  RunStore,
  TeamStore,
} from '../../application/ports.js';
import { createCloudSessionStore } from './cloudSessions.js';
import type { Database } from './database.js';
import { createFactoryStore } from './factories.js';
import { createHealthProbe } from './healthProbe.js';
import { createRunStore } from './runs.js';
import { createTeamStore } from './teams.js';

/** Every port the use cases need, on one Drizzle database. */
export function createDrizzleStores(db: Database): {
  health: HealthProbe;
  teams: TeamStore;
  factories: FactoryStore;
  runs: RunStore;
  cloudSessions: CloudSessionStore;
} {
  return {
    health: createHealthProbe(db),
    teams: createTeamStore(db),
    factories: createFactoryStore(db),
    runs: createRunStore(db),
    cloudSessions: createCloudSessionStore(db),
  };
}
