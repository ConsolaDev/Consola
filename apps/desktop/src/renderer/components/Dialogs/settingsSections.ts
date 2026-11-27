import type { Labs } from '../../../shared/labs';

/**
 * The Settings dialog's list, as data: which sections exist, which group each
 * sits in, and which one actually shows. No React, so the rules that can
 * strand the dialog — a workspace section with no workspace, a section this
 * computer hides — are testable.
 */

/** Sections that are the same in every workspace. */
export type AppSectionId =
  | 'appearance'
  | 'sessions'
  | 'appBrowser'
  | 'harnesses'
  | 'shortcuts'
  | 'updates';

/** Sections that edit the workspace this window is on. */
export type WorkspaceSectionId =
  | 'general'
  | 'titles'
  | 'scopes'
  | 'provider'
  | 'actions'
  | 'labels'
  | 'worktrees'
  | 'secrets'
  | 'browser'
  | 'danger';

export type SettingsSection = AppSectionId | WorkspaceSectionId;

/** The App group, in order. Updates is not in it: it is pinned below both groups. */
export const APP_GROUP: readonly AppSectionId[] = [
  'appearance',
  'sessions',
  'appBrowser',
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
  'secrets',
  'browser',
  'danger',
];

/**
 * Sections that belong to a lab (`shared/labs.ts`), listed only on a computer
 * that turns it on. Secrets binds the names automations use.
 */
const LAB_OF: Partial<Record<SettingsSection, keyof Labs>> = { secrets: 'automations' };

/** Whether this computer lists a section: every section that belongs to no lab, or to one it turned on. */
export function sectionShown(section: SettingsSection, labs: Pick<Labs, 'automations'>): boolean {
  const lab = LAB_OF[section];
  return lab === undefined || labs[lab];
}

/** Where the dialog opens before this window has left it anywhere. */
export const DEFAULT_SECTION: AppSectionId = 'appearance';

export function isWorkspaceSection(section: SettingsSection): section is WorkspaceSectionId {
  return (WORKSPACE_GROUP as readonly SettingsSection[]).includes(section);
}

/**
 * The section to show for the one asked for. A workspace section has nothing
 * to edit with no workspace open, and a section this computer hides is not
 * in the list, so either resolves to the default instead of an empty dialog.
 */
export function resolveSection(
  section: SettingsSection,
  hasWorkspace: boolean,
  labs: Pick<Labs, 'automations'>,
): SettingsSection {
  if (!sectionShown(section, labs)) return DEFAULT_SECTION;
  return isWorkspaceSection(section) && !hasWorkspace ? DEFAULT_SECTION : section;
}
