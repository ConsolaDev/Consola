import type { Membership, Organization } from '../domain/organization.js';

// What the use cases need from the world outside, each implemented by an adapter.

export type OrganizationStore = {
  /** The organisation with this slug, created if missing and renamed if its name changed. */
  ensure(wanted: { name: string; slug: string }): Promise<Organization>;
};

export type MembershipStore = {
  find(ids: { organizationId: string; userId: string }): Promise<Membership | null>;
  /**
   * The person's membership: an existing one unchanged, or a new one with the role `roleFor`
   * gives for the members already there. Safe when several joins arrive at once.
   */
  join(
    ids: { organizationId: string; userId: string },
    roleFor: (existingMembers: number) => string,
  ): Promise<Membership>;
};

export type PeopleStore = {
  /** Whether the person's email is verified, as stored now; null when there is no such person. */
  emailVerified(userId: string): Promise<boolean | null>;
};

export type HealthProbe = {
  /** Whether the database answers a query, never throwing when it does not. */
  databaseAnswers(): Promise<boolean>;
};
