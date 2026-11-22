import { openFolderInFavourite } from '../stores/openInStore';
import { currentTabFacts } from './sidePanelActions';

/**
 * ⌘O's action (Ctrl+Alt+O elsewhere), from the window's keydown and from a page
 * that has the keyboard (main forwards the chord on `browser:shortcut`):
 * opens the session's folder, the one its Folder row copies
 * (`checkoutPathForSession`), in the favourite, whether or not the info
 * panel shows. Does nothing, and answers false, with no session on screen,
 * the Inbox or Automations included, and while the session has no folder,
 * its worktree removed among them: there is nothing to open.
 */
export function openFolderOnScreen(): boolean {
  const folder = currentTabFacts()?.checkoutPath;
  if (!folder) return false;
  void openFolderInFavourite(folder);
  return true;
}
