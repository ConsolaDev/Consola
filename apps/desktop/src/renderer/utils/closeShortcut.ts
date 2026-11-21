import { isCloseShortcut as isClose } from '../../shared/shortcuts';
import { chordOf, PLATFORM } from './platform';

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
  return isClose(chordOf(event), PLATFORM);
}

export type CloseTarget = 'overlay' | 'browser-tab' | 'preview-tab';

/**
 * Where the keyboard was when ⌘W was pressed: in a page (main forwards the
 * chord with the tab it bound the page to, or null before it has), in the
 * browser panel's own controls, or anywhere else.
 */
export type KeyboardPlace =
  | { in: 'page'; tabId: string | null }
  | { in: 'browser-panel' }
  | { in: 'elsewhere' };

export interface CloseState {
  overlay: string | null;
  activeSessionId: string | null;
  activePreviewTabId: string | null;
  /** The Files tab, where previews show, is in front in a group on screen. */
  filesTabOnScreen: boolean;
  /** The browser tab showing beside the session, while its panel is on screen. */
  shownBrowserTabId: string | null;
  keyboard: KeyboardPlace;
}

/**
 * What ⌘W would close right now, front to back.
 *
 * The Inbox or Automations lies over the session pane, so it goes first; the
 * previews live in that pane's Files tab, and are on screen only without one
 * and while that tab is in front in a group on screen. Behind another tab,
 * in a group hidden by Maximize or in a hidden side panel, a preview is not
 * the nearest thing, and ⌘W leaves it alone.
 *
 * The browser tab showing beside the session comes between them, but only
 * while the keyboard is in the browser: in a page, or in the panel's toolbar
 * or tab strip. Anywhere else (the terminal, say) a page is not the nearest
 * thing, and ⌘W leaves it alone. The panel itself never closes, and with the
 * keyboard in it and no tab left, ⌘W closes nothing: closing a run of tabs
 * must not run on into a file in the previews.
 */
export function closeTarget(state: CloseState): CloseTarget | null {
  if (state.overlay !== null) return 'overlay';
  if (state.activeSessionId === null) return null;
  if (keyboardIsOnShownTab(state.keyboard, state.shownBrowserTabId)) return 'browser-tab';
  if (state.keyboard.in === 'browser-panel') return null;
  if (state.activePreviewTabId !== null && state.filesTabOnScreen) return 'preview-tab';
  return null;
}

/**
 * A page out of sight cannot hold the keyboard (it is `display: none`, or
 * `inert` while an agent reads it), so a page key names the shown tab; one
 * that names another tab is about no browser beside the session.
 */
function keyboardIsOnShownTab(keyboard: KeyboardPlace, shown: string | null): boolean {
  if (shown === null) return false;
  if (keyboard.in === 'browser-panel') return true;
  return keyboard.in === 'page' && (keyboard.tabId === null || keyboard.tabId === shown);
}
