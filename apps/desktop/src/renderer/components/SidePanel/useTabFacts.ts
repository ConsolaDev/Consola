import { useMemo } from 'react';
import { checkoutPathForSession, type Session, type Workspace } from '../../../shared/workspace';
import { useCheckout } from '../../stores/checkoutStore';
import { tabFactsFor, type TabFacts } from '../../sidePanel/tabKinds';

/** What the tab kinds read about a session on screen: its checkout, once git has said what it is. */
export function useTabFacts(workspace: Workspace, session: Session): TabFacts {
  const checkout = useCheckout(checkoutPathForSession(workspace, session) ?? null);
  return useMemo(() => tabFactsFor(workspace, session, checkout), [workspace, session, checkout]);
}
