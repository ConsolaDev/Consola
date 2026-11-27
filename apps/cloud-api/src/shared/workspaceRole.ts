/**
 * A person's role in a workspace: the one accounts keep on their membership (`member`). Company
 * code learns it only through the `MembershipReader`, read for each request, and decides what each
 * role may do there.
 */
export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);
}
