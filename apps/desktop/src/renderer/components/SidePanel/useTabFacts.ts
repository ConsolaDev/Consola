import { useMemo } from 'react';
import { checkoutPathForSession } from '../../../shared/workspace';
import type { Session, Workspace } from '../../../shared/workspace';
import { useFoundPullRequest } from '../../stores/branchPullRequestStore';
import { useCheckout } from '../../stores/checkoutStore';
import { tabFactsFor } from '../../sidePanel/tabKinds';
import type { TabFacts } from '../../sidePanel/tabKinds';

/**
 * What the tab kinds read about a session on screen: its checkout, once git
 * has said what it is, and the pull request found from its branch, once
 * looked up.
 */
export function useTabFacts(workspace: Workspace, session: Session): TabFacts {
  const checkout = useCheckout(checkoutPathForSession(workspace, session) ?? null);
  const found = useFoundPullRequest(workspace, session, checkout);
  return useMemo(
    () => tabFactsFor(workspace, session, checkout, found),
    [workspace, session, checkout, found],
  );
}
