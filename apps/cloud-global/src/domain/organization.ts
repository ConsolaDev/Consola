/** The deployment's one organisation. */
export type Organization = { id: string; name: string; slug: string };

/** A person's place in the organisation. */
export type Membership = { role: string };

/** Someone signed in, as the API shows them. */
export type Person = { id: string; name: string; email: string; image: string | null };

/** The first person to join an organisation owns it; everyone after is a member. */
export function roleForNewMember(existingMembers: number): 'owner' | 'member' {
  return existingMembers === 0 ? 'owner' : 'member';
}
