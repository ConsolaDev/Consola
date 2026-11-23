import { readUnfoldedText, unfoldedText } from '../domain/factoryNav';

/*
 * Which factories the person left unfolded in the sidebar, per workspace, in this browser's
 * storage. It is only a convenience: storage that is missing, full or refused (a private window,
 * blocked site data) reads as nothing unfolded and keeps nothing, and the sidebar works the same.
 */

const KEY_PREFIX = 'consola-cloud.unfolded-factories.';

/** The factories left unfolded in `workspaceId`, or none when storage holds nothing readable. */
export function readUnfolded(workspaceId: string): string[] {
  try {
    return readUnfoldedText(window.localStorage.getItem(`${KEY_PREFIX}${workspaceId}`));
  } catch {
    return [];
  }
}

/** Keeps the factories unfolded in `workspaceId`, when storage takes them. */
export function writeUnfolded(workspaceId: string, unfolded: readonly string[]): void {
  try {
    window.localStorage.setItem(`${KEY_PREFIX}${workspaceId}`, unfoldedText(unfolded));
  } catch {
    // Only a convenience: the sidebar works the same without it.
  }
}
