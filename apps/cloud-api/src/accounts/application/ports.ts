import type { WorkspaceRole } from '../../shared/workspaceRole.js';
import type { MyWorkspace, NewWorkspace, Workspace, WorkspaceMember } from '../domain/workspace.js';
import type { WorkspaceIcon } from '../domain/workspaceIcon.js';

// What the use cases need from the world outside, each implemented by an adapter.

export type WorkspaceStore = {
  /**
   * Makes the workspace and its first member, together with whatever the rest of the app opens
   * for a new workspace, or none of them. A slug that any workspace has is `slug-taken`, and
   * then nothing is written. A failure part-way writes nothing either, and rejects.
   */
  create(
    workspace: NewWorkspace,
    firstMember: { userId: string; role: WorkspaceRole },
  ): Promise<{ kind: 'created'; workspace: Workspace } | { kind: 'slug-taken' }>;
  /** Sets the workspace's icon, or clears it (null), and nothing else on the row. */
  setIcon(change: { workspaceId: string; icon: WorkspaceIcon | null }): Promise<void>;
};

export type MembershipStore = {
  /** The workspace as this person sees it, or null when they are not in it or it is not there. */
  workspaceFor(ids: { workspaceId: string; userId: string }): Promise<MyWorkspace | null>;
  /** Every workspace the person is in, in the order they joined. */
  workspacesOf(userId: string): Promise<MyWorkspace[]>;
  /** Every member of the workspace, with their role, in the order they joined. */
  membersOf(workspaceId: string): Promise<WorkspaceMember[]>;
};

export type SessionStore = {
  /** Makes the workspace the session's active one. */
  setActiveWorkspace(ids: { sessionId: string; workspaceId: string }): Promise<void>;
  /** The active workspace of the person's most recently used session that has one, if any. */
  lastActiveWorkspace(userId: string): Promise<string | null>;
};

export type PeopleStore = {
  /** Whether the person's email is verified, as stored now; null when there is no such person. */
  emailVerified(userId: string): Promise<boolean | null>;
};

export type HealthProbe = {
  /** Whether the database answers a query, never throwing when it does not. */
  databaseAnswers(): Promise<boolean>;
};
