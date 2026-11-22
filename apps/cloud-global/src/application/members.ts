import type { SignedIn } from '../domain/person.js';
import type { WorkspaceMember } from '../domain/workspace.js';
import type { MembershipStore } from './ports.js';

/**
 * The members of the session's active workspace, with their roles, in the order they joined.
 * Every member may see them: a person's teammates are the people they share the workspace with.
 * A session that names no workspace is `no-workspace`; one that names a workspace the person is
 * not in (any more, or ever), or one that is not there, is `not-a-member`, and lists no one.
 */
export async function listActiveWorkspaceMembers(
  memberships: MembershipStore,
  session: SignedIn,
): Promise<
  | { kind: 'listed'; members: WorkspaceMember[] }
  | { kind: 'no-workspace' }
  | { kind: 'not-a-member' }
> {
  const { person, activeWorkspaceId } = session;
  if (activeWorkspaceId === null) return { kind: 'no-workspace' };
  const workspace = await memberships.workspaceFor({
    workspaceId: activeWorkspaceId,
    userId: person.id,
  });
  if (!workspace) return { kind: 'not-a-member' };
  return { kind: 'listed', members: await memberships.membersOf(workspace.id) };
}
