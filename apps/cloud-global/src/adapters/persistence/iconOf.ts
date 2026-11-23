import { isWorkspaceIcon, type WorkspaceIcon } from '../../domain/workspaceIcon.js';

/**
 * A stored workspace's icon, kept in Better Auth's `organization.logo`. Only an id of
 * `WORKSPACE_ICONS` reads back as one; anything else (none, a logo address Better Auth was
 * handed, an id a later build added) reads as no icon, so the workspace shows its initial. Unlike
 * a region or a role, an icon decides nothing, so a value it does not know is never an error.
 */
export function iconOf(row: { logo: string | null }): WorkspaceIcon | null {
  return isWorkspaceIcon(row.logo) ? row.logo : null;
}
