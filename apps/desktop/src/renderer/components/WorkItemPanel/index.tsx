import { useRef } from 'react';
import { sameWorkItem, workItemKey, workItemUrl } from '../../../shared/workItems';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import type { Session } from '../../../shared/workspace';
import type { RevealTarget } from '../../infoPanel/pullRequestLines';
import { terminalBridge } from '../../services/terminalBridge';
import { useInboxStore } from '../../stores/inboxStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { InboxItemPane } from '../Inbox/InboxItemPane';
import './styles.css';

interface WorkItemPanelProps {
  workspaceId: string;
  /** The session the pane sits beside, which a Fix is pasted into. */
  session: Session;
  /** The item to show. Passed in rather than read off the session, so it can come from elsewhere. */
  workItem: WorkItemRef;
  onClose: () => void;
  /** Whether its tab is in front on screen: only then does the pane read the item. */
  active: boolean;
  /** A place in the item the person asked to see from the info panel. */
  reveal?: { at: RevealTarget; seq: number };
}

/**
 * An item the Inbox no longer lists — merged, closed, or out of its window —
 * stood in for by what its reference knows. The pane fills in title
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
 * A session's PR or issue, in the side panel's Pull request tab: the Inbox's
 * own pane — details, every session on the item, the ways to start another —
 * reading and writing as the workspace's account exactly as it does there.
 * One thing changes: a Fix goes to this session, pasted into its composer for
 * the person to send, never submitted on their behalf. A read-only session
 * cannot change code, so there a Fix drafts a new session, as in the Inbox.
 * Without the workspace or its account there is nothing to read, and it
 * renders nothing.
 */
export function WorkItemPanel({
  workspaceId,
  session,
  workItem,
  onClose,
  active,
  reveal,
}: WorkItemPanelProps) {
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId),
  );
  const cached = useInboxStore((state) =>
    state.snapshots[workspaceId]?.items.find((candidate) =>
      sameWorkItem(candidate.workItem, workItem),
    ),
  );
  const panelRef = useRef<HTMLDivElement>(null);

  if (!workspace?.provider) return null;

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
    // Hand the keyboard back to the conversation, so Enter sends what was
    // pasted: its terminal, never a session shell, which is a
    // `.terminal-panel` too.
    panelRef.current
      ?.closest('.workspace-view')
      ?.querySelector<HTMLElement>('[data-conversation-terminal] .terminal-surface textarea')
      ?.focus();
  };

  return (
    // A plain div: the pane's own section is the region, inside the side
    // panel's landmark.
    <div ref={panelRef} className="work-item-panel" data-testid="work-item-panel">
      <InboxItemPane
        // Keyed like the Inbox's pane, and by account too: no draft, open tab
        // or confirm carries over to another item, or to another login.
        key={`${workItemKey(workItem)}:${workspace.provider.accountLogin}`}
        workspace={workspace}
        item={cached ?? standInItem(workItem)}
        onClose={onClose}
        currentSessionId={session.id}
        fixInSession={session.toolPolicy === 'read-only' ? undefined : pasteIntoSession}
        active={active}
        landmark={false}
        reveal={reveal}
      />
    </div>
  );
}
