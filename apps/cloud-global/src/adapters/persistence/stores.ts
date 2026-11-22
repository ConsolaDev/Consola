import type {
  HealthProbe,
  InstallationStore,
  MembershipStore,
  OutboxStore,
  PeopleStore,
  SessionStore,
  WorkspaceStore,
} from '../../application/ports.js';
import type { Database } from './database.js';
import { createHealthProbe } from './healthProbe.js';
import { createInstallationStore } from './installationStore.js';
import { createMembershipStore } from './membershipStore.js';
import { createOutboxStore } from './outboxStore.js';
import { createPeopleStore } from './peopleStore.js';
import { createSessionStore } from './sessionStore.js';
import { createWorkspaceStore } from './workspaceStore.js';

/**
 * Every port the use cases need, on one Drizzle database. `messageWritten` is told after each
 * transaction that wrote an outbox message commits, so the worker that delivers them can wake.
 */
export function createDrizzleStores(
  db: Database,
  hooks: { messageWritten?: () => void } = {},
): {
  workspaces: WorkspaceStore;
  memberships: MembershipStore;
  sessions: SessionStore;
  people: PeopleStore;
  outbox: OutboxStore;
  installations: InstallationStore;
  health: HealthProbe;
} {
  return {
    workspaces: createWorkspaceStore(db, hooks),
    memberships: createMembershipStore(db),
    sessions: createSessionStore(db),
    people: createPeopleStore(db),
    outbox: createOutboxStore(db),
    installations: createInstallationStore(db),
    health: createHealthProbe(db),
  };
}
