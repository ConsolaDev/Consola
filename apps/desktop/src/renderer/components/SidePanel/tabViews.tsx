import type { ReactNode } from 'react';
import type { TabFacts, TabKindId } from '../../sidePanel/tabKinds';
import { GitReviewPanel } from '../GitReviewPanel';

export interface TabViewProps {
  facts: TabFacts;
  /** Closes this tab, as its close button does. */
  close: () => void;
}

/**
 * What each kind shows in its tab. Keyed by every kind id, so a kind added to
 * the registry without a view does not typecheck. A view is rendered only
 * where `bodyFor` answers 'view', which is the gate its own effects sit behind.
 */
export const TAB_VIEWS: Record<TabKindId, (props: TabViewProps) => ReactNode> = {
  changes: ({ facts, close }) => (
    <GitReviewPanel instanceId={facts.session.instanceId} onClose={close} />
  ),
};
