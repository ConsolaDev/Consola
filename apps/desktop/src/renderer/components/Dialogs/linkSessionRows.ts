import { sessionLabel } from '../../../shared/sessionLabel';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import { sameWorkItem, workItemKey } from '../../../shared/workItems';
import { scopeForSession, type Session, type Workspace } from '../../../shared/workspace';
import type { TerminalState } from '../../stores/terminalStore';
import { basename } from '../../utils/fileUtils';
import { sessionStatusFor, type SessionStatus } from '../../utils/sessionStatus';
import { formatAge } from '../Inbox/inboxPresentation';
import type { SearchableListItem } from '../SearchableList';

/**
 * One pickable row. Whichever door opened the dialog, a row knows the exact
 * (session, item) pair it would link, so submitting is the same call twice.
 */
export interface LinkRow extends SearchableListItem {
  sessionId: string;
  workItem: WorkItemRef;
  status?: SessionStatus;
}

/**
 * The Inbox-pane door: this workspace's sessions, most recent first.
 * Conductors are hidden — main would refuse them anyway, and a row that can
 * only ever fail is noise. A session already on an item stays listed but
 * greyed, with the reason in place of its context.
 */
export function sessionRowsFor(
  workspace: Workspace,
  item: InboxItem,
  terminals: Record<string, TerminalState>,
  now: number = Date.now()
): LinkRow[] {
  return workspace.sessions
    .filter((session) => session.kind !== 'conductor')
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .map((session) => {
      const runsIn = session.cwd ?? scopeForSession(workspace, session)?.path ?? '';
      const row: LinkRow = {
        id: session.id,
        label: sessionLabel(session),
        context: `${basename(runsIn)} · ${formatAge(session.lastActiveAt, now)}`,
        status: sessionStatusFor(terminals[session.instanceId]),
        sessionId: session.id,
        workItem: item.workItem,
      };
      if (session.workItem) {
        row.disabled = true;
        row.disabledHint = sameWorkItem(session.workItem, item.workItem)
          ? 'already on this item'
          : 'already linked';
      }
      return row;
    });
}

/** The sidebar door: the workspace's cached inbox items, in inbox order. */
export function itemRowsFor(items: InboxItem[], session: Session): LinkRow[] {
  return items.map((item) => {
    const row: LinkRow = {
      id: workItemKey(item.workItem),
      label: `#${item.workItem.number} ${item.title}`,
      context: item.workItem.repo,
      sessionId: session.id,
      workItem: item.workItem,
    };
    if (sameWorkItem(session.workItem, item.workItem)) {
      row.disabled = true;
      row.disabledHint = 'already linked here';
    }
    return row;
  });
}
