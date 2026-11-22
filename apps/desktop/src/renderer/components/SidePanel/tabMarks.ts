import { sameWorkItem } from '../../../shared/workItems';
import { alertPanelWords, alertWords, pullRequestAlert } from '../../infoPanel/pullRequestAlert';
import { detailsTargetOf, sessionPullRequest } from '../../infoPanel/sessionPullRequest';
import type { MarkTone } from '../../sidePanel/marks';
import { isTabKindId, TAB_KINDS, type TabFacts, type TabKindId } from '../../sidePanel/tabKinds';
import { useBrowserAgentDot } from '../../stores/browserAgentDotStore';
import { useInboxStore } from '../../stores/inboxStore';
import { useDetailsEntry } from '../../stores/workItemDetailsStore';

/**
 * What a kind's mark says, beside the dot that draws it. Where it is drawn
 * is `markPlaces`' to decide; whether there is one is the kind's own.
 */
export interface TabMark {
  /** Which dot draws it: the accent one for an agent's use, the red one for something wrong. */
  tone: MarkTone;
  /** Said after the kind's own name: "Browser, which the agent used". */
  onKind: string;
  /** Said after the side panel toggle's label: "Show side panel, where the agent used the browser". */
  onPanel: string;
}

const BROWSER_MARK: TabMark = {
  tone: 'agent',
  onKind: 'which the agent used',
  onPanel: 'where the agent used the browser',
};

/** An agent opened or used one of the session's pages while no Browser tab showed it. */
function useBrowserMark(facts: TabFacts): TabMark | null {
  return useBrowserAgentDot(facts.session.id) ? BROWSER_MARK : null;
}

/**
 * The session's pull request, linked or found from its branch, has a failing
 * check or a request for changes. Read from what is already known, its
 * cached details or the Inbox's copy of it, whichever is newer: it never
 * watches or loads, so a mark drawn with no viewer on screen asks for nothing.
 */
function usePullRequestMark(facts: TabFacts): TabMark | null {
  const item = sessionPullRequest(facts.session, facts.foundPullRequest);
  const target = detailsTargetOf(facts.workspace, item?.ref);
  const entry = useDetailsEntry(target);
  const inbox = useInboxStore((state) => state.snapshots[facts.workspace.id]);
  if (!target) return null;
  const alert = pullRequestAlert({
    details: entry?.details,
    detailsAt: entry?.fetchedAt ?? 0,
    item: inbox?.items.find((candidate) => sameWorkItem(candidate.workItem, target.ref)),
    itemAt: inbox?.fetchedAt ?? 0,
  });
  if (!alert) return null;
  return { tone: 'alert', onKind: alertWords(alert), onPanel: alertPanelWords(alert) };
}

/** Each entry is a hook; a kind without one has no mark. */
export const TAB_MARKS: Partial<Record<TabKindId, (facts: TabFacts) => TabMark | null>> = {
  browser: useBrowserMark,
  'pull-request': usePullRequestMark,
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
