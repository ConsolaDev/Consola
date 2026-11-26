import fs from 'node:fs';
import type { RunRecord } from '../../shared/automations';

/** How a run's checkout reaches the OS's file manager. */
export interface OpenRunCheckoutDeps {
  /** A direct child of the worktree root, by real path (`WorktreeService.isManagedPath`). */
  isManagedPath: (dir: string) => boolean;
  /** Electron's `shell.openPath`: the empty string once opened, else why not. */
  openPath: (dir: string) => Promise<string>;
}

export const NO_CHECKOUT_TO_OPEN = 'This run has no checkout of its own to open.';

/** `lstat` says a real directory: a link is never followed, a file or a bundle's contents never handed over. */
function isRealDirectory(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The run page's Open folder (slice 3-B Task 22): a run's own checkout,
 * opened in the OS's file manager. `shell.openPath` runs a file or an app
 * bundle it is handed (review M5), so it gets the folder only when the
 * run's record names it `run-owned`, it is a direct child of the worktree
 * root by real path, and `lstat` says it is a real directory (a link is not
 * followed). Anything else is refused in one sentence, nothing opened.
 */
export async function openRunCheckout(
  run: Pick<RunRecord, 'checkout'> | null | undefined,
  deps: OpenRunCheckoutDeps,
): Promise<void> {
  const cwd = run?.checkout?.kind === 'run-owned' ? run.checkout.cwd : undefined;
  if (cwd === undefined || !deps.isManagedPath(cwd) || !isRealDirectory(cwd)) {
    throw new Error(NO_CHECKOUT_TO_OPEN);
  }
  const failed = await deps.openPath(cwd);
  if (failed) throw new Error(`Could not open its folder: ${failed}`);
}
