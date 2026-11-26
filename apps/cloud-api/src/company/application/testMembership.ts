import type { WorkspaceRole } from '../../shared/workspaceRole.js';
import { admitCaller } from '../domain/caller.js';
import type { Caller } from '../domain/caller.js';
import type { MembershipReader } from './ports.js';

/**
 * A stand-in for accounts' `member`, for company's tests, which never import accounts: who is a
 * member of which workspace, with which role, in the order they joined, as the test sets it.
 */
export type FakeMembership = MembershipReader & {
  /** Makes the person a member of the workspace with `role`, or gives them `role` there. */
  put(workspaceId: string, personId: string, role: WorkspaceRole): void;
  /** Takes the person out of the workspace. */
  remove(workspaceId: string, personId: string): void;
};

export function fakeMembership(): FakeMembership {
  const workspaces = new Map<string, Map<string, WorkspaceRole>>();
  return {
    async roleOf(personId, workspaceId) {
      return workspaces.get(workspaceId)?.get(personId) ?? null;
    },
    async memberIds(workspaceId) {
      return [...(workspaces.get(workspaceId)?.keys() ?? [])];
    },
    async workspaceIds() {
      return [...workspaces.keys()];
    },
    put(workspaceId, personId, role) {
      const members = workspaces.get(workspaceId) ?? new Map<string, WorkspaceRole>();
      members.set(personId, role);
      workspaces.set(workspaceId, members);
    },
    remove(workspaceId, personId) {
      workspaces.get(workspaceId)?.delete(personId);
    },
  };
}

/**
 * The caller a request is admitted as for `personId`, signed in with `workspaceId` active and shown,
 * with `role` there: only `admitCaller` makes one. For company's tests.
 */
export function callerAs(personId: string, role: WorkspaceRole, workspaceId = 'acme'): Caller {
  const admitted = admitCaller({
    signedIn: { personId, activeWorkspaceId: workspaceId },
    shownWorkspaceId: workspaceId,
    role,
  });
  if (!admitted.ok) throw new Error(`${personId} was not admitted: ${admitted.error}`);
  return admitted.caller;
}
