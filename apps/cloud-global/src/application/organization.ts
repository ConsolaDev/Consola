import { type Membership, type Organization, roleForNewMember } from '../domain/organization.js';
import { DEPLOYMENT_REGION } from '../domain/region.js';
import type { MembershipStore, OrganizationStore } from './ports.js';

/**
 * The deployment's one organisation, by slug. A new name renames it in place; a new slug is a
 * new organisation. It is made in `DEPLOYMENT_REGION`, and one that exists keeps its region.
 */
export function ensureOrganization(
  organizations: OrganizationStore,
  wanted: { name: string; slug: string },
): Promise<Organization> {
  return organizations.ensure({ ...wanted, region: DEPLOYMENT_REGION });
}

/**
 * Joins the organisation: the first member becomes its owner, later ones are members, and
 * joining again changes nothing.
 */
export function joinOrganization(
  memberships: MembershipStore,
  ids: { organizationId: string; userId: string },
): Promise<Membership> {
  return memberships.join(ids, roleForNewMember);
}
