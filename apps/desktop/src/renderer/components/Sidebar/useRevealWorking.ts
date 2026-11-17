import { useEffect, useRef } from 'react';
import type { AttentionState } from '../../../shared/attention';
import type { Entry } from '../../sidebar/entry';
import { startedWorking } from '../../sidebar/workingStarts';
import { useNavigationStore } from '../../stores/navigationStore';
import { isShelfOpen, useSettingsStore } from '../../stores/settingsStore';

type AttentionMap = AttentionState['attention'];

/** Shows the sidebar and opens Working, so every running session is in view. */
export function revealWorking(): void {
  const navigation = useNavigationStore.getState();
  if (navigation.isSidebarHidden) navigation.setSidebarHidden(false);
  const settings = useSettingsStore.getState();
  if (!isShelfOpen(settings.sidebarShelfOpen, 'working')) settings.toggleSidebarShelf('working', true);
}

/**
 * Whenever a row on the list starts working, the sidebar comes back if it was
 * hidden and Working opens, so every running session is on screen rather than
 * only the open one.
 *
 * Only a change in attention can start anything, so this runs only on one.
 * Switching workspace or changing a filter brings rows into view without
 * starting them, and neither re-runs it. The rows are read twice, against the
 * attention before and after the change, through the same providers that
 * build the list (`entriesAt`), so no kind of row is named here.
 */
export function useRevealWorking(
  attention: AttentionMap,
  shown: readonly Entry[],
  entriesAt: (attention: AttentionMap) => Entry[]
): void {
  const previous = useRef(attention);
  useEffect(() => {
    const before = previous.current;
    previous.current = attention;
    if (before === attention) return;
    if (startedWorking(shown, entriesAt(before))) revealWorking();
    // Deliberately keyed on attention alone: see above.
  }, [attention]);
}
