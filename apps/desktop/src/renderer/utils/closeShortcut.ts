import { isMac } from './platform';

/**
 * ⌘W closes the nearest thing on screen, never the window and never a session.
 *
 * The window moved to ⇧⌘W (main/index.ts): with one window open, closing it
 * reads as quitting. A session is not on the list either: closing one stops
 * its terminal and its conversation, far too much for a reflex.
 *
 * macOS only. Elsewhere the chord would be Ctrl+W, which the terminal needs:
 * it is delete-word-backwards in every shell and in Claude's composer.
 */
export function isCloseShortcut(event: KeyboardEvent): boolean {
  return (
    isMac &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'w'
  );
}

export type CloseTarget = 'overlay' | 'preview-tab';

/**
 * What ⌘W would close right now, front to back.
 *
 * The Inbox or Automations lies over the session pane, so it goes first; the
 * preview panel lives inside that pane and is only on screen without one.
 */
export function closeTarget(state: {
  overlay: string | null;
  activeSessionId: string | null;
  activePreviewTabId: string | null;
}): CloseTarget | null {
  if (state.overlay !== null) return 'overlay';
  if (state.activeSessionId !== null && state.activePreviewTabId !== null) return 'preview-tab';
  return null;
}
