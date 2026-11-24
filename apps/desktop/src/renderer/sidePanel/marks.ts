/**
 * Where a kind's mark is drawn: something its view has for the person that
 * they have not seen (the agent used the browser), or something wrong there
 * (the pull request has a failing check). The mark goes where the person can
 * see it without a control of its own: on the kind's header shortcut if it
 * has one, on its tab while that tab sits in a group on screen, and
 * otherwise on the side panel toggle, the one header control always drawn.
 * Whether a kind is marked is its own to say (`TAB_MARKS`).
 *
 * Pure, with no stores, so the node test environment can import it.
 */
import { visibleGroups } from './layout';
import type { SidePanelLayout } from './layout';

/** Which dot draws a mark: the accent one for an agent's use, the red one for something wrong. */
export type MarkTone = 'agent' | 'alert';

/**
 * The dots a button draws for the marks it carries, one attribute per tone.
 * A shortcut or a tab holds one kind, so at most one; the side panel toggle
 * can carry both.
 */
export function markDots(marks: readonly { tone: MarkTone }[]): {
  'data-agent-dot'?: true;
  'data-alert-dot'?: true;
} {
  return {
    'data-agent-dot': marks.some((mark) => mark.tone === 'agent') || undefined,
    'data-alert-dot': marks.some((mark) => mark.tone === 'alert') || undefined,
  };
}

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

/** The marks drawn on the side panel toggle: every marked kind whose markPlaces says toggle, in the entries' (registry) order. */
export function marksOnToggle<
  M extends { kind: string; mark: { tone: MarkTone; onPanel: string } | null },
>(
  entries: readonly M[],
  input: { headerKinds: readonly string[]; layout: SidePanelLayout },
): Array<NonNullable<M['mark']>> {
  const marks: Array<NonNullable<M['mark']>> = [];
  for (const { kind, mark } of entries) {
    if (mark && markPlaces(kind, { marked: true, ...input }).toggle) marks.push(mark);
  }
  return marks;
}

/** `label` alone with no phrases, else `${label}, ${phrases.join(' and ')}`. */
export function labelWithMarks(label: string, phrases: readonly string[]): string {
  return phrases.length === 0 ? label : `${label}, ${phrases.join(' and ')}`;
}
