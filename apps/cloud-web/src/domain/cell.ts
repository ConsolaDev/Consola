import { regionName } from './workspace';

/**
 * Why a call to the workspace's regional cell came to nothing. Every page that reads a cell
 * (Teams, Runs) answers in these, and says each the same way (`messageForCellRefusal`).
 */
export type CellRefusal =
  /** The cell does not hold the workspace yet: `cloud-global` is still telling it. */
  | { kind: 'pending' }
  /** The session's workspace is not the one the page shows: another tab switched it. */
  | { kind: 'switched' }
  | { kind: 'signed-out' }
  /** The cell, or `cloud-global`, does not answer, or answers what the page does not expect. */
  | { kind: 'unavailable' };

/** What a page says when its workspace's cell could not be read, for the workspace and its region. */
export function messageForCellRefusal(
  refusal: CellRefusal,
  workspace: { name: string; region: string },
): string {
  switch (refusal.kind) {
    case 'pending':
      return `${workspace.name} is still being set up in its region. Try again in a moment.`;
    case 'switched':
      return 'Your session has another workspace open now, perhaps from another tab. Reload to see it.';
    case 'signed-out':
      return 'You’ve been signed out. Reload to sign in again.';
    case 'unavailable':
      return `The ${regionName(workspace.region)} region isn’t answering. Start it with pnpm dev:cloud-region and try again.`;
  }
}
