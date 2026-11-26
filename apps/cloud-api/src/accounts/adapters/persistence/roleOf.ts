import { isWorkspaceRole } from '../../../shared/workspaceRole.js';
import type { WorkspaceRole } from '../../../shared/workspaceRole.js';

/**
 * A stored membership's role, read back only when it is one of the contract's
 * `WORKSPACE_ROLES`. Any other value is a row nothing here wrote, and it is an error rather than
 * a guess: a cell learns roles from `cloud-global`, so a role it does not know must not reach it.
 */
export function roleOf(row: { slug: string; role: string }): WorkspaceRole {
  if (!isWorkspaceRole(row.role)) {
    throw new Error(`A member of ${row.slug} has an unknown role, "${row.role}".`);
  }
  return row.role;
}
