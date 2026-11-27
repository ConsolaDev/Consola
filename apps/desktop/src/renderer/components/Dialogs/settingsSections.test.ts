import { describe, expect, it } from 'vitest';
import {
  APP_GROUP,
  DEFAULT_SECTION,
  WORKSPACE_GROUP,
  isWorkspaceSection,
  resolveSection,
  sectionShown,
} from './settingsSections';

describe('the settings list', () => {
  it('keeps Updates out of the App group: it is pinned below both groups', () => {
    expect(APP_GROUP).toEqual(['appearance', 'sessions', 'appBrowser', 'harnesses', 'shortcuts']);
    expect(APP_GROUP).not.toContain('updates');
  });

  it('lists the workspace sections, Sessions right after General', () => {
    expect(WORKSPACE_GROUP).toEqual([
      'general',
      'titles',
      'scopes',
      'provider',
      'actions',
      'labels',
      'worktrees',
      'secrets',
      'browser',
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
  const SHOWN = { automations: true };

  it('shows a workspace section when a workspace is open', () => {
    expect(resolveSection('scopes', true, SHOWN)).toBe('scopes');
  });

  it('shows Secrets with a workspace open, and the default without one', () => {
    expect(resolveSection('secrets', true, SHOWN)).toBe('secrets');
    expect(resolveSection('secrets', false, SHOWN)).toBe(DEFAULT_SECTION);
  });

  it('falls back to Appearance for a workspace section with no workspace open', () => {
    // Asked for by a door, or remembered from the last time the dialog was
    // open: either way there is no workspace record to edit.
    for (const section of WORKSPACE_GROUP) {
      expect(resolveSection(section, false, SHOWN)).toBe('appearance');
    }
  });

  it('leaves an app-wide section alone, workspace or not', () => {
    expect(resolveSection('updates', false, SHOWN)).toBe('updates');
    expect(resolveSection('harnesses', false, SHOWN)).toBe('harnesses');
    expect(resolveSection('sessions', true, SHOWN)).toBe('sessions');
  });

  it('falls back to Appearance for Secrets on a computer that hides Automations (labs)', () => {
    expect(resolveSection('secrets', true, { automations: false })).toBe(DEFAULT_SECTION);
    expect(resolveSection('scopes', true, { automations: false })).toBe('scopes');
  });
});

describe('sectionShown', () => {
  it('lists Secrets only where Automations shows, and every other section everywhere', () => {
    expect(sectionShown('secrets', { automations: true })).toBe(true);
    expect(sectionShown('secrets', { automations: false })).toBe(false);
    for (const section of [...APP_GROUP, ...WORKSPACE_GROUP]) {
      if (section !== 'secrets') expect(sectionShown(section, { automations: false })).toBe(true);
    }
  });
});
