import { type Membership, type Organization, roleForNewMember } from '../domain/organization.js';
import type { MembershipStore, OrganizationStore } from './ports.js';

/**
 * The deployment's one organisation, by slug. A new name renames it in place; a new slug is a
 * new organisation.
 */
export function ensureOrganization(
  organizations: OrganizationStore,
  wanted: { name: string; slug: string },
): Promise<Organization> {
  return organizations.ensure(wanted);
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
