import { chordOf } from './platform';
import { isShellShortcut as isShell } from '../../shared/shortcuts';

export const SHELL_SHORTCUT_LABEL = 'Ctrl+`';

/** Use the physical key as well so the chord works on non-US layouts. */
export function isShellShortcut(event: KeyboardEvent): boolean {
  return isShell(chordOf(event));
}
