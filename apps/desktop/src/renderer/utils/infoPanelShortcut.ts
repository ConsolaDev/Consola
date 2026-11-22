import { chordOf, PLATFORM } from './platform';
import {
  INFO_PANEL_SHORTCUT_LABELS,
  isInfoPanelShortcut as isInfoPanel,
} from '../../shared/shortcuts';

export const INFO_PANEL_SHORTCUT_LABEL = INFO_PANEL_SHORTCUT_LABELS[PLATFORM];

/** Shows or hides the info panel beside the session on screen. */
export function isInfoPanelShortcut(event: KeyboardEvent): boolean {
  return isInfoPanel(chordOf(event), PLATFORM);
}
