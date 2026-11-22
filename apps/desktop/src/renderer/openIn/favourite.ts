import type { OpenInTarget } from '../../shared/openIn';

/**
 * The app the "Open in" button and ⌘O open a folder in: the last one the
 * person picked (`favouriteId`, from `settingsStore`) while it is still
 * installed, else the file manager, which main always offers. Undefined
 * only while main has listed nothing yet.
 */
export function favouriteTarget(
  targets: readonly OpenInTarget[],
  favouriteId: string | null,
): OpenInTarget | undefined {
  return (
    targets.find((target) => target.id === favouriteId) ??
    targets.find((target) => target.kind === 'file-manager')
  );
}
