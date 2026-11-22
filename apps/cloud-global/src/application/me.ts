import type { Organization, Person } from '../domain/organization.js';
import type { MembershipStore } from './ports.js';

/** Who is asking, in this organisation: nobody, someone who is not a member, or a member. */
export async function describeMe(
  memberships: MembershipStore,
  organization: Organization,
  person: Person | null,
): Promise<
  | { kind: 'signed-out' }
  | { kind: 'not-member' }
  | { kind: 'member'; me: { user: Person; organization: Organization; role: string } }
> {
  if (!person) return { kind: 'signed-out' };

  const membership = await memberships.find({
    organizationId: organization.id,
    userId: person.id,
  });
  if (!membership) return { kind: 'not-member' };

  return {
    kind: 'member',
    me: {
      user: { id: person.id, name: person.name, email: person.email, image: person.image },
      organization: { id: organization.id, name: organization.name, slug: organization.slug },
      role: membership.role,
    },
  };
}
