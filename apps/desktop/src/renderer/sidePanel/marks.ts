/**
 * Where a kind's mark is drawn: something its view has for the person that
 * they have not seen (the agent used the browser). The mark goes where the
 * person can see it without a control of its own: on the kind's header
 * shortcut if it has one, on its tab while that tab sits in a group on
 * screen, and otherwise on the side panel toggle, the one header control
 * always drawn. Whether a kind is marked is its own to say (`TAB_MARKS`).
 *
 * Pure, with no stores, so the node test environment can import it.
 */
import { type SidePanelLayout, visibleGroups } from './layout';

export interface MarkPlaces {
  shortcut: boolean;
  tab: boolean;
  toggle: boolean;
}

/** Where a kind's mark is drawn: its header shortcut, its tab while in a group on screen, else the side panel toggle. */
export function markPlaces(
  kind: string,
  input: { marked: boolean; headerKinds: readonly string[]; layout: SidePanelLayout },
): MarkPlaces {
  if (!input.marked) return { shortcut: false, tab: false, toggle: false };
  const shortcut = input.headerKinds.includes(kind);
  const tab = visibleGroups(input.layout).some((group) => group.tabs.includes(kind));
  return { shortcut, tab, toggle: !shortcut && !tab };
}
