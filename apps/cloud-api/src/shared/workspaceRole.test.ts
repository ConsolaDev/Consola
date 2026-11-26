import { describe, expect, it } from 'vitest';
import { isWorkspaceRole, WORKSPACE_ROLES } from './workspaceRole.js';

describe('workspace roles', () => {
  it('are owner, admin and member', () => {
    expect(WORKSPACE_ROLES).toEqual(['owner', 'admin', 'member']);
  });

  it('isWorkspaceRole accepts only a listed role', () => {
    expect(isWorkspaceRole('owner')).toBe(true);
    expect(isWorkspaceRole('admin')).toBe(true);
    expect(isWorkspaceRole('member')).toBe(true);
    expect(isWorkspaceRole('Owner')).toBe(false);
    // Better Auth can store several roles in one column; a cell is told exactly one.
    expect(isWorkspaceRole('admin,member')).toBe(false);
    expect(isWorkspaceRole('')).toBe(false);
    expect(isWorkspaceRole(undefined)).toBe(false);
  });
});
