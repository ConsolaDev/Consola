import { isTabKindId, TAB_KINDS, type TabFacts, type TabKindId } from '../../sidePanel/tabKinds';
import { useBrowserAgentDot } from '../../stores/browserAgentDotStore';

/**
 * What a kind's mark says, beside the dot that draws it. Where it is drawn
 * is `markPlaces`' to decide; whether there is one is the kind's own.
 */
export interface TabMark {
  /** Said after the kind's own name: "Browser, which the agent used". */
  onKind: string;
  /** Said after the side panel toggle's label: "Show side panel, where the agent used the browser". */
  onPanel: string;
}

const BROWSER_MARK: TabMark = {
  onKind: 'which the agent used',
  onPanel: 'where the agent used the browser',
};

/** An agent opened or used one of the session's pages while no Browser tab showed it. */
function useBrowserMark(facts: TabFacts): TabMark | null {
  return useBrowserAgentDot(facts.session.id) ? BROWSER_MARK : null;
}

/** Each entry is a hook; a kind without one has no mark. */
export const TAB_MARKS: Partial<Record<TabKindId, (facts: TabFacts) => TabMark | null>> = {
  browser: useBrowserMark,
};

const noMark = (): null => null;

function markReaderOf(kind: string): (facts: TabFacts) => TabMark | null {
  return (isTabKindId(kind) && TAB_MARKS[kind]) || noMark;
}

/**
 * One kind's mark; the placeholder and a kind this build does not list have
 * none. Its caller is keyed by its kind, so one component always calls the
 * same reader, and the hooks inside run in the same order on every render.
 */
export function useTabMark(kind: string, facts: TabFacts): TabMark | null {
  return markReaderOf(kind)(facts);
}

/**
 * Every kind's mark, in registry order. The registry is fixed for the run,
 * so every render calls the same readers in the same order, as hooks must be.
 */
export function useTabMarks(
  facts: TabFacts,
): ReadonlyArray<{ kind: TabKindId; mark: TabMark | null }> {
  return TAB_KINDS.map((kind) => ({ kind: kind.id, mark: markReaderOf(kind.id)(facts) }));
}
