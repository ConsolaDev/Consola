import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, ExternalLink, FolderGit2, PanelRight, Tag } from 'lucide-react';
import { PROVIDER_META } from '../../../shared/providers';
import { sessionLabel } from '../../../shared/sessionLabel';
import { sameWorkItem, workItemUrl } from '../../../shared/workItems';
import type { Session } from '../../../shared/workspace';
import { useInboxStore } from '../../stores/inboxStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { tildePath } from '../../utils/displayPath';
import { activateSession } from '../../utils/sessionActions';
import { sessionStatusFor } from '../../utils/sessionStatus';
import { metaLineFor } from '../Inbox/inboxPresentation';
import { RunActionMenu } from '../RunActionMenu';
import './styles.css';

interface WorkItemStripProps {
  workspaceId: string;
  session: Session;
}

/**
 * The thin strip above a work-item session's terminal: live PR/issue facts,
 * the action this session was started as, its siblings on the same item,
 * and where it physically runs. It reads the same cache as the Inbox — one
 * fetcher, one rate-limit budget. Run sends one of the workspace's actions
 * into this session (a follow-up pass, in this tab); its Details toggle
 * opens the item beside the terminal (WorkItemPanel), which is where the
 * item itself can be acted on.
 *
 * Only what can be pressed has an edge: the action and the worktree are
 * facts about this session, so they read as text, never as buttons.
 *
 * A merged/closed item drops out of the inbox; the strip then falls back to
 * the workItem on the session record, because the session and its
 * transcript outlive the work item.
 */
export function WorkItemStrip({ workspaceId, session }: WorkItemStripProps) {
  const workItem = session.workItem;
  const item = useInboxStore((state) =>
    workItem
      ? state.snapshots[workspaceId]?.items.find((candidate) =>
          sameWorkItem(candidate.workItem, workItem)
        )
      : undefined
  );
  // The whole workspace is selected (a stable reference) and the siblings
  // derived below: a selector returning a fresh array would re-render forever.
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId)
  );
  const terminals = useTerminalStore((state) => state.terminals);
  const isPanelVisible = useNavigationStore((state) => state.isWorkItemPanelVisible);
  const togglePanel = useNavigationStore((state) => state.toggleWorkItemPanel);

  if (!workItem) return null;
  const label = workItem.type === 'pr' ? 'PR' : 'Issue';
  const noun = workItem.type === 'pr' ? 'PR' : 'issue';
  const providerName = PROVIDER_META[workItem.provider].displayName;
  const siblings = (workspace?.sessions ?? []).filter(
    (candidate) => candidate.id !== session.id && sameWorkItem(candidate.workItem, workItem)
  );
  const total = siblings.length + 1;

  return (
    <div className="work-item-strip">
      <div className="work-item-strip-text">
        <span className="work-item-strip-title">
          #{workItem.number} {item?.title ?? `${label} in ${workItem.repo}`}
        </span>
        <span className="work-item-strip-meta">
          {item ? metaLineFor(item) : `${workItem.repo} · no longer in the inbox`}
        </span>
      </div>
      {(session.workItemAction || session.cwd) && (
        <span className="work-item-strip-facts">
          {session.workItemAction && (
            <span className="work-item-strip-fact" title={`Started with the ${session.workItemAction} action`}>
              {/* A label, not a verb: a play glyph would read as "run this". */}
              <Tag size={12} aria-hidden="true" />
              {session.workItemAction}
            </span>
          )}
          {session.cwd && (
            <span className="work-item-strip-fact" title={`Runs in its own worktree: ${tildePath(session.cwd)}`}>
              <FolderGit2 size={12} aria-hidden="true" />
              worktree · {workItem.type}-{workItem.number}
            </span>
          )}
        </span>
      )}
      {workspace && (
        <RunActionMenu workspace={workspace} session={session} triggerClassName="work-item-strip-button" />
      )}
      {siblings.length > 0 && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="work-item-strip-button"
              aria-label={`${total} sessions on this ${noun}`}
            >
              {total} sessions <ChevronDown size={12} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="dropdown-content" sideOffset={4} align="end">
              {siblings.map((sibling) => {
                const status = sessionStatusFor(terminals[sibling.instanceId]);
                return (
                  <DropdownMenu.Item
                    key={sibling.id}
                    className="dropdown-item"
                    onSelect={() => activateSession(workspaceId, sibling.id)}
                  >
                    <span className={`status-dot status-dot--${status}`} aria-hidden="true" />
                    <span>{sessionLabel(sibling)}</span>
                  </DropdownMenu.Item>
                );
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      <a
        className="work-item-strip-link"
        href={item?.url ?? workItemUrl(workItem)}
        target="_blank"
        rel="noreferrer"
      >
        Open on {providerName} <ExternalLink size={12} />
      </a>
      {/* The panel reads as the workspace's account; without one it has
          nothing to show, so there is nothing to toggle. */}
      {workspace?.provider && (
        <button
          type="button"
          className="work-item-strip-button"
          aria-pressed={isPanelVisible}
          title={isPanelVisible ? `Hide ${noun} details` : `Show ${noun} details beside the session`}
          onClick={togglePanel}
        >
          <PanelRight size={13} aria-hidden="true" />
          Details
        </button>
      )}
    </div>
  );
}
