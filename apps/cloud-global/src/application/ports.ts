import type { WorkspaceRole } from '@consola/cloud-contract';
import type { MyWorkspace, NewWorkspace, Workspace } from '../domain/workspace.js';

// What the use cases need from the world outside, each implemented by an adapter.

export type WorkspaceStore = {
  /**
   * Makes the workspace and its first member, together or not at all. A slug that any workspace
   * has, in any region, is `slug-taken`, and then nothing is written.
   */
  create(
    workspace: NewWorkspace,
    firstMember: { userId: string; role: WorkspaceRole },
  ): Promise<{ kind: 'created'; workspace: Workspace } | { kind: 'slug-taken' }>;
};

export type MembershipStore = {
  /** The workspace as this person sees it, or null when they are not in it or it is not there. */
  workspaceFor(ids: { workspaceId: string; userId: string }): Promise<MyWorkspace | null>;
  /** Every workspace the person is in, in the order they joined. */
  workspacesOf(userId: string): Promise<MyWorkspace[]>;
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
