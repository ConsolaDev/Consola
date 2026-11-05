import { useRef } from 'react';
import { sameWorkItem, workItemKey, workItemUrl } from '../../../shared/workItems';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import type { Session } from '../../../shared/workspace';
import { terminalBridge } from '../../services/terminalBridge';
import { useInboxStore } from '../../stores/inboxStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { InboxItemPane } from '../Inbox/InboxItemPane';
import './styles.css';

interface WorkItemPanelProps {
  workspaceId: string;
  session: Session;
}

/**
 * An item the Inbox no longer lists — merged, closed, or out of its window —
 * stood in for by what the session's record knows. The pane fills in title
 * and author once it has read the details; the empty state reads as unknown,
 * so no badge shows until then.
 */
function standInItem(ref: WorkItemRef): InboxItem {
  return {
    workItem: ref,
    title: `${ref.type === 'pr' ? 'Pull request' : 'Issue'} #${ref.number}`,
    author: '',
    roles: [],
    isDraft: false,
    state: '',
    reviewDecision: 'none',
    commentCount: 0,
    updatedAt: '',
    url: workItemUrl(ref),
  };
}

/**
 * A linked session's PR or issue, beside its terminal: the Inbox's own pane —
 * details, every session on the item, the ways to start another — reading and
 * writing as the workspace's account exactly as it does there. One thing
 * changes: a Fix goes to this session, pasted into its composer for the
 * person to send, never submitted on their behalf. A read-only session cannot
 * change code, so there a Fix drafts a new session, as in the Inbox.
 */
export function WorkItemPanel({ workspaceId, session }: WorkItemPanelProps) {
  const workItem = session.workItem;
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId)
  );
  const cached = useInboxStore((state) =>
    workItem
      ? state.snapshots[workspaceId]?.items.find((candidate) =>
          sameWorkItem(candidate.workItem, workItem)
        )
      : undefined
  );
  const setVisible = useNavigationStore((state) => state.setWorkItemPanelVisible);
  const panelRef = useRef<HTMLDivElement>(null);

  if (!workItem || !workspace?.provider) return null;

  const instanceId = session.instanceId;

  // Pasting is input like any other, so it waits behind the same guard as a
  // queued prompt: text sent while a menu is on screen would answer it.
  const pasteIntoSession = (prompt: string): string | void => {
    const terminal = useTerminalStore.getState().terminals[instanceId];
    if (terminal?.hasExited) {
      return 'This session has exited. Restart it, then try again.';
    }
    if (terminal?.isAwaitingConfirmation) {
      return 'This session is waiting on a menu. Answer it in the terminal, then try again.';
    }
    terminalBridge.paste(instanceId, prompt);
    // Hand the keyboard back to the terminal, so Enter sends what was pasted.
    panelRef.current
      ?.closest('.workspace-view')
      ?.querySelector<HTMLElement>('.terminal-panel .terminal-surface textarea')
      ?.focus();
  };

  return (
    // A plain div: the pane's own <aside> is the landmark.
    <div ref={panelRef} className="work-item-panel" data-testid="work-item-panel">
      <InboxItemPane
        // Keyed like the Inbox's pane, and by account too: no draft, open tab
        // or confirm carries over to another item, or to another login.
        key={`${workItemKey(workItem)}:${workspace.provider.accountLogin}`}
        workspace={workspace}
        item={cached ?? standInItem(workItem)}
        onClose={() => setVisible(false)}
        currentSessionId={session.id}
        fixInSession={session.toolPolicy === 'read-only' ? undefined : pasteIntoSession}
      />
    </div>
  );
}
