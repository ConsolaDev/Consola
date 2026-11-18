/**
 * The one flat set of section ids the unified Settings dialog shows: the app
 * group, the workspace group, and Updates, pinned below both. The two id
 * sets do not collide, so a single `SettingsSection` names any section.
 */
export type AppSectionId = 'appearance' | 'sessions' | 'harnesses' | 'shortcuts' | 'updates';
export type WorkspaceSectionId =
  | 'general'
  | 'scopes'
  | 'provider'
  | 'actions'
  | 'labels'
  | 'danger';
export type SettingsSection = AppSectionId | WorkspaceSectionId;

/** The App group, in order. `updates` is not in it: it is pinned below both groups. */
export const APP_GROUP: readonly AppSectionId[] = [
  'appearance',
  'sessions',
  'harnesses',
  'shortcuts',
];

/** The Workspace group, in order. */
export const WORKSPACE_GROUP: readonly WorkspaceSectionId[] = [
  'general',
  'scopes',
  'provider',
  'actions',
  'labels',
  'danger',
];

export const DEFAULT_SECTION: AppSectionId = 'appearance';

export function isWorkspaceSection(section: SettingsSection): section is WorkspaceSectionId {
  return (WORKSPACE_GROUP as readonly SettingsSection[]).includes(section);
}

/** A workspace section with no workspace resolves to DEFAULT_SECTION. */
export function resolveSection(section: SettingsSection, hasWorkspace: boolean): SettingsSection {
  if (hasWorkspace || !isWorkspaceSection(section)) return section;
  return DEFAULT_SECTION;
}
