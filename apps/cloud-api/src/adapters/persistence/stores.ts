import type {
  HealthProbe,
  MembershipStore,
  OrganizationStore,
  PeopleStore,
} from '../../application/ports.js';
import type { Database } from './database.js';
import { createHealthProbe } from './healthProbe.js';
import { createMembershipStore } from './membershipStore.js';
import { createOrganizationStore } from './organizationStore.js';
import { createPeopleStore } from './peopleStore.js';

/** Every port the use cases need, on one Drizzle database. */
export function createDrizzleStores(db: Database): {
  organizations: OrganizationStore;
  memberships: MembershipStore;
  people: PeopleStore;
  health: HealthProbe;
} {
  return {
    organizations: createOrganizationStore(db),
    memberships: createMembershipStore(db),
    people: createPeopleStore(db),
    health: createHealthProbe(db),
  };
}
