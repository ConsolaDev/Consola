import { chordOf, PLATFORM } from './platform';
import { isOpenInShortcut as isOpenIn, OPEN_IN_SHORTCUT_LABELS } from '../../shared/shortcuts';

export const OPEN_IN_SHORTCUT_LABEL = OPEN_IN_SHORTCUT_LABELS[PLATFORM];

/** The chord as `aria-keyshortcuts` spells it. */
export const OPEN_IN_ARIA_KEYSHORTCUTS = PLATFORM === 'mac' ? 'Meta+O' : 'Control+O';

/** Opens the session's folder in the favourite app (`openFolderOnScreen`). */
export function isOpenInShortcut(event: KeyboardEvent): boolean {
  return isOpenIn(chordOf(event), PLATFORM);
}
