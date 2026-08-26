// src/renderer/components/Sidebar/sidebarSections.test.ts
import { describe, expect, it } from 'vitest';
import { sidebarSectionForSession } from './sidebarSections';

const LIVE = new Set(['group-live']);

describe('sidebarSectionForSession', () => {
  it('answers the scope for an ungrouped session', () => {
    expect(sidebarSectionForSession(LIVE, { scopeId: 'scope-a' })).toBe('scope-a');
  });

  it('answers the group for a session in a live one', () => {
    expect(
      sidebarSectionForSession(LIVE, { scopeId: 'scope-a', groupId: 'group-live' })
    ).toBe('group-live');
  });

  // Archiving hands members back to their scopes, so the section follows.
  it('falls back to the scope when the group is archived', () => {
    expect(
      sidebarSectionForSession(LIVE, { scopeId: 'scope-a', groupId: 'group-archived' })
    ).toBe('scope-a');
  });

  it('falls back to the scope when the group is gone entirely', () => {
    expect(
      sidebarSectionForSession(new Set(), { scopeId: 'scope-a', groupId: 'group-live' })
    ).toBe('scope-a');
  });
});
