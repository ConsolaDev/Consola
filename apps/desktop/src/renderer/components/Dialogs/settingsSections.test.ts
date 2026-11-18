import { describe, expect, it } from 'vitest';
import {
  APP_GROUP,
  DEFAULT_SECTION,
  WORKSPACE_GROUP,
  isWorkspaceSection,
  resolveSection,
} from './settingsSections';

describe('the settings list', () => {
  it('keeps Updates out of the App group: it is pinned below both groups', () => {
    expect(APP_GROUP).toEqual(['appearance', 'sessions', 'harnesses', 'shortcuts']);
    expect(APP_GROUP).not.toContain('updates');
  });

  it('lists the workspace sections, Session titles right after General', () => {
    expect(WORKSPACE_GROUP).toEqual([
      'general',
      'titles',
      'scopes',
      'provider',
      'actions',
      'labels',
      'danger',
    ]);
  });

  it('opens on Appearance', () => {
    expect(DEFAULT_SECTION).toBe('appearance');
  });
});

describe('isWorkspaceSection', () => {
  it('is true for every section of the Workspace group', () => {
    for (const section of WORKSPACE_GROUP) expect(isWorkspaceSection(section)).toBe(true);
  });

  it('is false for every app-wide section, Updates included', () => {
    for (const section of APP_GROUP) expect(isWorkspaceSection(section)).toBe(false);
    expect(isWorkspaceSection('updates')).toBe(false);
  });
});

describe('resolveSection', () => {
  it('shows a workspace section when a workspace is open', () => {
    expect(resolveSection('scopes', true)).toBe('scopes');
  });

  it('falls back to Appearance for a workspace section with no workspace open', () => {
    // Asked for by a door, or remembered from the last time the dialog was
    // open: either way there is no workspace record to edit.
    for (const section of WORKSPACE_GROUP)
      expect(resolveSection(section, false)).toBe('appearance');
  });

  it('leaves an app-wide section alone, workspace or not', () => {
    expect(resolveSection('updates', false)).toBe('updates');
    expect(resolveSection('harnesses', false)).toBe('harnesses');
    expect(resolveSection('sessions', true)).toBe('sessions');
  });
});
