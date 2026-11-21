import { type ComponentType, useState } from 'react';
import { isInFront } from '../../sidePanel/layout';
import type { TabFacts, TabKindId } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { GitReviewPanel } from '../GitReviewPanel';
import { WorkItemPanel } from '../WorkItemPanel';
import { FilesTab } from './FilesTab';

export interface TabViewProps {
  facts: TabFacts;
  /** Closes this tab, as its close button does. */
  close: () => void;
}

/**
 * The session's pull request or issue. The pane reads the item's details
 * from GitHub, as the workspace's account, as soon as it mounts, and a pane
 * nobody can see must not spend that account's request budget. So it mounts
 * only once this tab has been in front on screen, and from then on stays
 * mounted behind other tabs, keeping its drafts, scroll and own tab. The slot
 * is keyed by session, so arriving on another session starts unseen again:
 * with the tab behind, nothing is read until the person brings it forward.
 */
function PullRequestView({ facts, close }: TabViewProps) {
  const inFront = useSidePanelStore((state) => isInFront(state.layout, 'pull-request'));
  const [hasBeenInFront, setHasBeenInFront] = useState(inFront);
  // Derived from the previous render, so set during render rather than in an
  // effect: the pane mounts in the same commit that brings the tab forward.
  if (inFront && !hasBeenInFront) setHasBeenInFront(true);

  // Pull request is unavailable without a linked item, so that null never shows.
  const workItem = facts.session.workItem;
  if (!hasBeenInFront || !workItem) return null;
  return (
    <WorkItemPanel
      workspaceId={facts.workspace.id}
      session={facts.session}
      workItem={workItem}
      onClose={close}
    />
  );
}

/**
 * What each kind shows in its tab. Keyed by every kind id, so a kind added to
 * the registry without a view does not typecheck. A view is rendered only
 * where `bodyFor` answers 'view', which is the gate its own effects sit behind.
 * Each is a component, rendered as one, so the hooks a view uses are its own
 * and never join those of the slot that holds it.
 */
export const TAB_VIEWS: Record<TabKindId, ComponentType<TabViewProps>> = {
  changes: ({ facts, close }) => (
    <GitReviewPanel instanceId={facts.session.instanceId} onClose={close} />
  ),
  // Files is unavailable whenever there is no path, so the null never shows.
  files: ({ facts }) => (facts.checkoutPath ? <FilesTab rootPath={facts.checkoutPath} /> : null),
  'pull-request': PullRequestView,
};
