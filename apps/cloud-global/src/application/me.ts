import type { Person, SignedIn } from '../domain/person.js';
import type { MyWorkspace } from '../domain/workspace.js';
import type { MembershipStore } from './ports.js';

/**
 * Who is asking, and the workspace their session has active. A session whose active workspace
 * the person is no longer in, or that names none, has no workspace.
 */
export async function describeMe(
  memberships: MembershipStore,
  session: SignedIn | null,
): Promise<
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; me: { user: Person; workspace: MyWorkspace | null } }
> {
  if (!session) return { kind: 'signed-out' };

  const { person, activeWorkspaceId } = session;
  const workspace = activeWorkspaceId
    ? await memberships.workspaceFor({ workspaceId: activeWorkspaceId, userId: person.id })
    : null;

  return {
    kind: 'signed-in',
    me: {
      user: { id: person.id, name: person.name, email: person.email, image: person.image },
      workspace,
    },
  };
}
