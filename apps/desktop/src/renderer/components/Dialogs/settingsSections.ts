/**
 * The Settings dialog's list, as data: which sections exist, which group each
 * sits in, and which one actually shows. No React, so the one rule that can
 * strand the dialog — a workspace section with no workspace — is testable.
 */

/** Sections that are the same in every workspace. */
export type AppSectionId = 'appearance' | 'sessions' | 'harnesses' | 'shortcuts' | 'updates';

/** Sections that edit the workspace this window is on. */
export type WorkspaceSectionId =
  | 'general'
  | 'titles'
  | 'scopes'
  | 'provider'
  | 'actions'
  | 'labels'
  | 'worktrees'
  | 'danger';

export type SettingsSection = AppSectionId | WorkspaceSectionId;

/** The App group, in order. Updates is not in it: it is pinned below both groups. */
export const APP_GROUP: readonly AppSectionId[] = [
  'appearance',
  'sessions',
  'harnesses',
  'shortcuts',
];

/** The Workspace group, in order. Shown only while a workspace is open. */
export const WORKSPACE_GROUP: readonly WorkspaceSectionId[] = [
  'general',
  'titles',
  'scopes',
  'provider',
  'actions',
  'labels',
  'worktrees',
  'danger',
];

/** Where the dialog opens before this window has left it anywhere. */
export const DEFAULT_SECTION: AppSectionId = 'appearance';

export function isWorkspaceSection(section: SettingsSection): section is WorkspaceSectionId {
  return (WORKSPACE_GROUP as readonly SettingsSection[]).includes(section);
}

/**
 * The section to show for the one asked for. A workspace section has nothing
 * to edit with no workspace open, so it resolves to the default instead of an
 * empty dialog.
 */
export function resolveSection(section: SettingsSection, hasWorkspace: boolean): SettingsSection {
  return isWorkspaceSection(section) && !hasWorkspace ? DEFAULT_SECTION : section;
}
