import { useState } from 'react';
import type { ComponentType } from 'react';
import { isRevealTarget } from '../../infoPanel/pullRequestLines';
import { isInFront } from '../../sidePanel/layout';
import { sessionItemOf } from '../../sidePanel/tabKinds';
import type { TabFacts, TabKindId } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { BrowserPanel } from '../Browser';
import { GitReviewPanel } from '../GitReviewPanel';
import { ShellPanel } from '../Terminal/ShellPanel';
import { WorkItemPanel } from '../WorkItemPanel';
import { FilesTab } from './FilesTab';

export interface TabViewProps {
  facts: TabFacts;
  /** Closes this tab, as its close button does. */
  close: () => void;
}

/**
 * The session's pull request or issue, read from GitHub as the workspace's
 * account: the linked one, else the pull request found from its branch. The
 * pane mounts only once this tab has been in front on screen:
 * an unseen pane draws nothing, since what it draws (avatars, images in the
 * description) loads even while hidden. From then on it stays mounted behind
 * other tabs, keeping its drafts, scroll and own tab, but reads only while in
 * front (`active`): a seen pane behind another tab is neither read again once
 * stale nor polled for its mergeability, so it spends none of the account's
 * request budget. The slot is keyed by session, so arriving on another
 * session starts unseen again. A place asked for from the info panel (the
 * merge card, Files changed) is handed to the pane, for this session only.
 */
function PullRequestView({ facts, close }: TabViewProps) {
  const inFront = useSidePanelStore((state) => isInFront(state.layout, 'pull-request'));
  const request = useSidePanelStore((state) => state.revealRequest);
  const [hasBeenInFront, setHasBeenInFront] = useState(inFront);
  // Derived from the previous render, so set during render rather than in an
  // effect: the pane mounts in the same commit that brings the tab forward.
  if (inFront && !hasBeenInFront) setHasBeenInFront(true);

  // Pull request is unavailable with neither a linked item nor one found
  // from the branch, so that null never shows.
  const workItem = sessionItemOf(facts);
  if (!hasBeenInFront || !workItem) return null;
  const reveal =
    request?.kind === 'pull-request' &&
    request.sessionId === facts.session.id &&
    isRevealTarget(request.target)
      ? { at: request.target, seq: request.seq }
      : undefined;
  return (
    <WorkItemPanel
      workspaceId={facts.workspace.id}
      session={facts.session}
      workItem={workItem}
      onClose={close}
      active={inFront}
      reveal={reveal}
    />
  );
}

/**
 * The session's shell. Terminal mounts only in front, so this mounts each
 * time the tab comes in front on screen and attaches, which spawns the shell
 * the first time and otherwise repaints it from main's snapshot. It takes the
 * keyboard only when the person's own action brought the tab in front, never
 * when a session switch, a relaunch or a return from an overlay mounts it.
 */
function TerminalView({ facts }: TabViewProps) {
  return (
    <ShellPanel
      key={facts.session.instanceId}
      instanceId={facts.session.instanceId}
      sessionId={facts.session.id}
      focusOnAttach={() => useSidePanelStore.getState().takeFocusRequest('terminal')}
    />
  );
}

/**
 * The session's browser: main's own panel, unchanged. Browser mounts only in
 * front, so this mounts exactly while its tab is in front on screen, which is
 * when it claims the slot its page is drawn over and clears the agent's dot.
 * The pages are never in here: they live in `BrowserHost`, so the tab going
 * behind, its group hidden or the side panel hidden only hides the page.
 */
function BrowserView({ facts }: TabViewProps) {
  return (
    <BrowserPanel
      sessionId={facts.session.id}
      instanceId={facts.session.instanceId}
      cwd={facts.checkoutPath ?? ''}
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
  terminal: TerminalView,
  browser: BrowserView,
  'pull-request': PullRequestView,
};
