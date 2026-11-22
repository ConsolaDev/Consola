import { type RefObject, useLayoutEffect, useRef } from 'react';
import { branchSectionShown } from '../../infoPanel/branchLines';
import { pullRequestSectionView } from '../../infoPanel/sessionPullRequest';
import type { TabFacts } from '../../sidePanel/tabKinds';
import { useBranchLookupEntry } from '../../stores/branchPullRequestStore';
import { keyboardToConversation } from '../SidePanel/keyboardAfterClose';
import { BranchSection } from './BranchSection';
import { EnvironmentSection } from './EnvironmentSection';
import { PullRequestSection } from './PullRequestSection';
import './styles.css';

/**
 * The info panel: a glance at the session beside its conversation, in
 * sections that fold, drawn in `INFO_SECTION_IDS` order. It never navigates
 * (a row with more behind it opens a tab of the side panel) and never takes
 * the keyboard by itself, on mount or otherwise.
 */
export function InfoPanel({ facts }: { facts: TabFacts }) {
  const panelRef = useRef<HTMLElement>(null);
  useKeyboardKeptOnLeaving(panelRef);
  const { checkout, session, workspace } = facts;
  // A branch a pull request could be found from: checked out, and not removed.
  const branch =
    checkout && checkout.kind !== 'none' && !session.removedWorktree ? checkout.branch : undefined;
  // What the lookup last answered; `ContentView` asks, while the section is open.
  const lookup = useBranchLookupEntry(workspace, session);
  const pullRequest = pullRequestSectionView({
    session,
    hasAccount: Boolean(workspace.provider),
    hasBranch: !!branch,
    lookup,
    branch,
  });
  return (
    <aside ref={panelRef} aria-label="Session info" className="info-panel">
      <EnvironmentSection facts={facts} />
      {branchSectionShown(facts) && <BranchSection facts={facts} />}
      {pullRequest.kind !== 'hidden' && <PullRequestSection facts={facts} view={pullRequest} />}
    </aside>
  );
}

/**
 * Should the panel leave the screen with the keyboard on one of its rows, the
 * keyboard goes to the conversation once that has rendered, never to the
 * body. A row that opens a tab can make the panel step aside for a narrow
 * window (`infoPanel/stepAside.ts`), taking the row just pressed with it. A
 * view the row opened that took the keyboard keeps it.
 */
function useKeyboardKeptOnLeaving(panelRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const panel = panelRef.current;
    return () => {
      // Still in the document here: a layout effect's cleanup runs before
      // its elements are removed.
      if (!panel?.contains(document.activeElement)) return;
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) keyboardToConversation();
      });
    };
  }, [panelRef]);
}
