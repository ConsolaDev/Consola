import { describe, expect, it } from 'vitest';
import {
  APP_GROUP,
  DEFAULT_SECTION,
  WORKSPACE_GROUP,
  isWorkspaceSection,
  resolveSection,
} from './settingsSections';

describe('settingsSections', () => {
  describe('resolveSection', () => {
    it('keeps a workspace section while a workspace is open', () => {
      expect(resolveSection('scopes', true)).toBe('scopes');
    });

    it('lands a workspace section on Appearance with no workspace open', () => {
      expect(resolveSection('scopes', false)).toBe('appearance');
    });

    it('keeps Updates with no workspace open', () => {
      expect(resolveSection('updates', false)).toBe('updates');
    });
  });

  describe('isWorkspaceSection', () => {
    it('is true for every Workspace group id', () => {
      for (const section of WORKSPACE_GROUP) expect(isWorkspaceSection(section)).toBe(true);
    });

    it('is false for every App group id and for Updates', () => {
      for (const section of [...APP_GROUP, 'updates' as const]) {
        expect(isWorkspaceSection(section)).toBe(false);
      }
    });
  });

  it('defaults to Appearance, which is not Updates', () => {
    expect(DEFAULT_SECTION).toBe('appearance');
    expect(APP_GROUP.includes('updates')).toBe(false);
  });
});
