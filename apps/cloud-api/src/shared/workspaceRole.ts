/**
 * A person's role in a workspace: the one `cloud-global` keeps on their membership. A cell learns
 * it from the token and from the outbox, never from anywhere else, and decides what each role
 * may do there.
 */
export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);
}
