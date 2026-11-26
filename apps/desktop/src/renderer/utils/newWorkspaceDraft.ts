import type { FolderInfo } from '../types/electron';

/**
 * Where a workspace runs. Every workspace is local today; a cloud one is
 * offered so people know it is coming, and cannot be picked yet. Nothing is
 * stored for it: a workspace record gains a location only once a cloud
 * workspace can exist.
 */
export type WorkspaceLocation = 'local' | 'cloud';

export const WORKSPACE_LOCATIONS: ReadonlyArray<{ id: WorkspaceLocation; available: boolean }> = [
  { id: 'local', available: true },
  { id: 'cloud', available: false },
];

/** The dialog's steps, in order: where it runs, what it is called, which folders it holds. */
export const NEW_WORKSPACE_STEPS = ['location', 'name', 'folders'] as const;
export type NewWorkspaceStep = (typeof NEW_WORKSPACE_STEPS)[number];

export interface NewWorkspaceDraft {
  location: WorkspaceLocation;
  name: string;
  /** Each becomes a scope, the first one first. */
  folders: FolderInfo[];
}

export function emptyDraft(): NewWorkspaceDraft {
  return { location: 'local', name: '', folders: [] };
}

/** Whether a step is answered well enough to leave it: Next, or Create on the last. */
export function canContinue(step: NewWorkspaceStep, draft: NewWorkspaceDraft): boolean {
  const available =
    WORKSPACE_LOCATIONS.find((location) => location.id === draft.location)?.available ?? false;
  if (step === 'location') return available;
  const named = draft.name.trim().length > 0;
  if (step === 'name') return named;
  return available && named && draft.folders.length > 0;
}

/** The folders listed so far plus the ones just picked, each path once, in picking order. */
export function mergeFolders(current: FolderInfo[], picked: FolderInfo[]): FolderInfo[] {
  const seen = new Set(current.map((folder) => folder.path));
  const merged = [...current];
  for (const folder of picked) {
    if (seen.has(folder.path)) continue;
    seen.add(folder.path);
    merged.push(folder);
  }
  return merged;
}
