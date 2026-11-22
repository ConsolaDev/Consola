import { chordOf, PLATFORM } from './platform';
import {
  isSidePanelShortcut as isSidePanel,
  SIDE_PANEL_SHORTCUT_LABELS,
} from '../../shared/shortcuts';

export const SIDE_PANEL_SHORTCUT_LABEL = SIDE_PANEL_SHORTCUT_LABELS[PLATFORM];

/** Shows or hides the side panel beside the session on screen. */
export function isSidePanelShortcut(event: KeyboardEvent): boolean {
  return isSidePanel(chordOf(event), PLATFORM);
}
