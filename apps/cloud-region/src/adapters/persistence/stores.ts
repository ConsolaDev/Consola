import type {
  FactoryStore,
  GitHubEventStore,
  HealthProbe,
  RunStore,
  TeamStore,
  WorkspaceCopies,
} from '../../application/ports.js';
import type { Database } from './database.js';
import { createFactoryStore } from './factories.js';
import { createGitHubEventStore } from './gitHubEvents.js';
import { createHealthProbe } from './healthProbe.js';
import { createRunStore } from './runs.js';
import { createTeamStore } from './teams.js';
import { createWorkspaceCopies } from './workspaceCopies.js';

/** Every port the use cases need, on one Drizzle database. */
export function createDrizzleStores(db: Database): {
  health: HealthProbe;
  workspaceCopies: WorkspaceCopies;
  teams: TeamStore;
  factories: FactoryStore;
  gitHubEvents: GitHubEventStore;
  runs: RunStore;
} {
  return {
    health: createHealthProbe(db),
    workspaceCopies: createWorkspaceCopies(db),
    teams: createTeamStore(db),
    factories: createFactoryStore(db),
    gitHubEvents: createGitHubEventStore(db),
    runs: createRunStore(db),
  };
}
