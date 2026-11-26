/**
 * Why a call for what the workspace the page shows holds (its teams, factories, runs and cloud
 * sessions) came to nothing. Every page that reads them answers in these, and says each the same
 * way (`messageForRefusal`).
 */
export type Refusal =
  /**
   * The session's workspace is not the one the page shows: another tab switched it, it has none
   * open, or the person is no longer a member of it.
   */
  | { kind: 'switched' }
  | { kind: 'signed-out' }
  /** The API does not answer, or answers what the page does not expect. */
  | { kind: 'unavailable' };

/** What a page says when what its workspace holds could not be read. */
export function messageForRefusal(refusal: Refusal): string {
  switch (refusal.kind) {
    case 'switched':
      return 'Your session has another workspace open now, perhaps from another tab. Reload to see it.';
    case 'signed-out':
      return 'You’ve been signed out. Reload to sign in again.';
    case 'unavailable':
      return 'Consola Cloud isn’t answering. Start it with pnpm dev:cloud and try again.';
  }
}
