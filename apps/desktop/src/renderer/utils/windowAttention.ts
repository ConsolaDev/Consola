/** What a document says about whether it is in front of the person. */
export interface WindowAttention {
  visibilityState: DocumentVisibilityState;
  hasFocus: () => boolean;
}

/**
 * Whether the person can be looking at this window now: shown and focused.
 * Main keeps pushing to windows that are minimized, on another Space,
 * behind another app or beside the one being worked in — none of those
 * has been seen.
 */
export function isLookedAt(view: WindowAttention = document): boolean {
  return view.visibilityState === 'visible' && view.hasFocus();
}
