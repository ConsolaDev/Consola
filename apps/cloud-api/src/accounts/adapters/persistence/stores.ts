import type {
  HealthProbe,
  MembershipStore,
  PeopleStore,
  SessionStore,
  WorkspaceStore,
} from '../../application/ports.js';
import type { Database } from './database.js';
import { createHealthProbe } from './healthProbe.js';
import { createMembershipStore } from './membershipStore.js';
import { createPeopleStore } from './peopleStore.js';
import { createSessionStore } from './sessionStore.js';
import { createWorkspaceStore } from './workspaceStore.js';
import type { WorkspaceStoreHooks } from './workspaceStore.js';

/**
 * Every port accounts' use cases need, on one Drizzle database. `onCreated` runs inside the
 * transaction that makes a workspace (`createWorkspaceStore`).
 */
export function createDrizzleStores(
  db: Database,
  hooks: WorkspaceStoreHooks = {},
): {
  workspaces: WorkspaceStore;
  memberships: MembershipStore;
  sessions: SessionStore;
  people: PeopleStore;
  health: HealthProbe;
} {
  return {
    workspaces: createWorkspaceStore(db, hooks),
    memberships: createMembershipStore(db),
    sessions: createSessionStore(db),
    people: createPeopleStore(db),
    health: createHealthProbe(db),
  };
}
