import type { Person, SignedIn } from '../domain/person.js';
import type { Region } from '../domain/region.js';
import {
  CREATOR_ROLE,
  checkNewWorkspace,
  defaultActiveWorkspace,
  mayManageWorkspace,
} from '../domain/workspace.js';
import type { MyWorkspace, WorkspaceProblem } from '../domain/workspace.js';
import { checkWorkspaceIcon } from '../domain/workspaceIcon.js';
import type { MembershipStore, SessionStore, WorkspaceStore } from './ports.js';

/**
 * Makes a workspace for the person signed in: `checkNewWorkspace` first, then the store, which
 * refuses a slug any workspace has. It is made in `region`, the deployment's, never one the
 * request names. The creator is its owner, and their session opens it. A store that fails, part
 * of the way or at all, rejects, and the session is left as it was.
 */
export async function createWorkspace(
  stores: { workspaces: WorkspaceStore; sessions: SessionStore },
  session: SignedIn,
  request: { name?: unknown; slug?: unknown },
  region: Region,
): Promise<
  | { kind: 'created'; workspace: MyWorkspace }
  | { kind: 'invalid'; problems: WorkspaceProblem[] }
  | { kind: 'slug-taken' }
> {
  const checked = checkNewWorkspace(request);
  if (!checked.ok) return { kind: 'invalid', problems: checked.problems };

  const made = await stores.workspaces.create({ ...checked.workspace, region }, {
    userId: session.person.id,
    role: CREATOR_ROLE,
  });
  if (made.kind === 'slug-taken') return made;

  await stores.sessions.setActiveWorkspace({
    sessionId: session.sessionId,
    workspaceId: made.workspace.id,
  });
  return { kind: 'created', workspace: { ...made.workspace, role: CREATOR_ROLE, icon: null } };
}

/** The workspaces the person is in, with their role in each, in the order they joined. */
export function listMyWorkspaces(
  memberships: MembershipStore,
  person: Person,
): Promise<MyWorkspace[]> {
  return memberships.workspacesOf(person.id);
}

/**
 * Makes a workspace the session's active one, if the person is in it. One they are not in, and
 * one that does not exist, are both `not-found`, so the answer never says which workspaces
 * exist.
 */
export async function setActiveWorkspace(
  stores: { memberships: MembershipStore; sessions: SessionStore },
  session: SignedIn,
  workspaceId: string,
): Promise<{ kind: 'active'; workspace: MyWorkspace } | { kind: 'not-found' }> {
  const workspace = await stores.memberships.workspaceFor({
    workspaceId,
    userId: session.person.id,
  });
  if (!workspace) return { kind: 'not-found' };

  await stores.sessions.setActiveWorkspace({ sessionId: session.sessionId, workspaceId });
  return { kind: 'active', workspace };
}

/** The workspace a person's new session starts in (`defaultActiveWorkspace`), or none. */
export async function workspaceForNewSession(
  stores: { memberships: MembershipStore; sessions: SessionStore },
  userId: string,
): Promise<string | null> {
  const [lastActive, mine] = await Promise.all([
    stores.sessions.lastActiveWorkspace(userId),
    stores.memberships.workspacesOf(userId),
  ]);
  return defaultActiveWorkspace({ lastActive, memberOf: mine.map((workspace) => workspace.id) });
}

/**
 * Sets the icon of the session's active workspace, or clears it (null). Only an owner or an admin
 * may (`mayManageWorkspace`), and the role is read from the database, never from the request. A
 * session that names no workspace is `no-workspace`; one that names a workspace the person is not
 * in is `not-a-member`; an icon `checkWorkspaceIcon` refuses is `invalid`. It writes the icon
 * alone: the workspace's region, name and slug are never touched.
 */
export async function setWorkspaceIcon(
  stores: { memberships: MembershipStore; workspaces: WorkspaceStore },
  session: SignedIn,
  request: { icon?: unknown },
): Promise<
  | { kind: 'changed'; workspace: MyWorkspace }
  | { kind: 'invalid'; problem: 'icon_unknown' }
  | { kind: 'no-workspace' }
  | { kind: 'not-a-member' }
  | { kind: 'not-allowed' }
> {
  const { person, activeWorkspaceId } = session;
  if (activeWorkspaceId === null) return { kind: 'no-workspace' };
  const workspace = await stores.memberships.workspaceFor({
    workspaceId: activeWorkspaceId,
    userId: person.id,
  });
  if (!workspace) return { kind: 'not-a-member' };
  if (!mayManageWorkspace(workspace.role)) return { kind: 'not-allowed' };

  const checked = checkWorkspaceIcon(request.icon);
  if (!checked.ok) return { kind: 'invalid', problem: checked.problem };

  await stores.workspaces.setIcon({ workspaceId: workspace.id, icon: checked.icon });
  return { kind: 'changed', workspace: { ...workspace, icon: checked.icon } };
}
